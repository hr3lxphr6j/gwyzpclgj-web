// C ABI bridge between the JavaScript worker and OpenCV.
//
// This file only orchestrates decoding, background sampling, Haar detection,
// cropping and JPEG re-encoding; all pure formulas live in photo_logic.
//
// Conventions:
//   * All exported state is static and single-threaded (one worker owns the
//     module). Buffers are reused by the next call, so JavaScript must copy
//     the output bytes immediately after photo_process returns.
//   * photo_process returns 0 on success and the original tool's error codes
//     otherwise: 1 = invalid/truncated JPEG, 2 = image smaller than 295x413,
//     3 = background rejected, 4 = head ratio or centering check failed,
//     5 = no face detected. Error 6 is a web-only extension for an unsupported
//     or undecodable non-JPEG format. Unexpected internal failures return -1
//     and leave a message in the error buffer.
//   * Metadata is reset on every photo_process call. Fields that were not
//     reached keep their neutral value: face/crop rectangles are all zero
//     before a face is detected and before a crop is accepted, input/output
//     dimensions are zero before decoding, and bg_class is -1 until background
//     sampling has produced a verdict (0 = white, 1 = blue, 3 = rejected).

#include <climits>
#include <cstdint>
#include <cstring>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

#include <opencv2/core.hpp>
#include <opencv2/imgcodecs.hpp>
#include <opencv2/imgproc.hpp>
#include <opencv2/objdetect.hpp>

#include "photo_logic.h"

namespace {

// One cascade per module instance. photo_init_cascade is called once per
// worker; a failed re-init leaves detection disabled until a later successful
// init, so detection never runs with a partially configured cascade.
cv::CascadeClassifier g_cascade;
bool g_cascade_ready = false;

// Output and error buffers handed to JavaScript by pointer.
std::vector<uint8_t> g_output;
std::string g_error;

// Decoded BGR image used by photo_test_decode only (for external comparison
// of processing results, e.g. a similarity check against a reference output).
std::vector<uint8_t> g_test_bgr;
int g_test_bgr_w = 0;
int g_test_bgr_h = 0;

// Metadata mirrors of the last photo_process call.
int g_face_x = 0;
int g_face_y = 0;
int g_face_w = 0;
int g_face_h = 0;
int g_crop_x = 0;
int g_crop_y = 0;
int g_crop_w = 0;
int g_crop_h = 0;
int g_input_w = 0;
int g_input_h = 0;
int g_output_w = 0;
int g_output_h = 0;
int g_bg_class = -1;

// Cascade XML is materialised in the in-memory filesystem so that
// CascadeClassifier::load can read it and run OpenCV's legacy-format upgrade.
constexpr const char* kCascadePath = "/cascade.xml";

void ResetMetadata() {
  g_face_x = g_face_y = g_face_w = g_face_h = 0;
  g_crop_x = g_crop_y = g_crop_w = g_crop_h = 0;
  g_input_w = g_input_h = 0;
  g_output_w = g_output_h = 0;
  g_bg_class = -1;
}

void ClearError() { g_error.clear(); }

void SetError(const char* stage, const char* detail) {
  g_error = stage;
  if (detail != nullptr && detail[0] != '\0') {
    g_error += ": ";
    g_error += detail;
  }
}

// Signature checks. The original tool only accepts JPEG; the web build also
// accepts common still-image formats, but detection is always by file content,
// never by extension or the browser-provided MIME type.
bool LooksLikeJpeg(const uint8_t* data, size_t len) {
  return data != nullptr && len >= 2 && data[0] == 0xFF && data[1] == 0xD8;
}

bool LooksLikePng(const uint8_t* data, size_t len) {
  static const uint8_t kSignature[8] = {0x89, 'P', 'N', 'G', 0x0D, 0x0A,
                                        0x1A, 0x0A};
  return data != nullptr && len >= sizeof(kSignature) &&
         std::memcmp(data, kSignature, sizeof(kSignature)) == 0;
}

bool LooksLikeWebp(const uint8_t* data, size_t len) {
  return data != nullptr && len >= 12 &&
         std::memcmp(data, "RIFF", 4) == 0 &&
         std::memcmp(data + 8, "WEBP", 4) == 0;
}

bool LooksLikeBmp(const uint8_t* data, size_t len) {
  return data != nullptr && len >= 2 && data[0] == 'B' && data[1] == 'M';
}

bool LooksLikeTiff(const uint8_t* data, size_t len) {
  return data != nullptr && len >= 4 &&
         ((data[0] == 'I' && data[1] == 'I' && data[2] == 0x2A &&
           data[3] == 0x00) ||
          (data[0] == 'M' && data[1] == 'M' && data[2] == 0x00 &&
           data[3] == 0x2A));
}

enum class ImageFormat { kJpeg, kPng, kWebp, kBmp, kTiff, kUnsupported };

ImageFormat DetectFormat(const uint8_t* data, size_t len) {
  if (LooksLikeJpeg(data, len)) return ImageFormat::kJpeg;
  if (LooksLikePng(data, len)) return ImageFormat::kPng;
  if (LooksLikeWebp(data, len)) return ImageFormat::kWebp;
  if (LooksLikeBmp(data, len)) return ImageFormat::kBmp;
  if (LooksLikeTiff(data, len)) return ImageFormat::kTiff;
  return ImageFormat::kUnsupported;
}

// Walk the header segments up to the first SOS, then require an EOI marker in
// the entropy-coded data. OpenCV's libjpeg backend returns a partially decoded
// image for a truncated stream (missing rows keep whatever the allocator last
// stored), so without this check a cut-off upload can reach background and
// face processing with garbage pixels and produce a non-deterministic result.
// Inside a scan every 0xFF is either stuffed (FF 00), a restart marker
// (FF D0-D7) or a real marker, so the first FF D9 is the end of image.
bool HasEndOfImage(const uint8_t* data, size_t len) {
  size_t i = 2;  // skip SOI (already validated by LooksLikeJpeg)
  while (i + 1 < len) {
    if (data[i] != 0xFF) return false;
    while (i < len && data[i] == 0xFF) ++i;  // fill bytes
    if (i >= len) return false;
    const uint8_t marker = data[i++];
    if (marker == 0xD9) return false;  // EOI before any scan
    if (marker == 0x01 || (marker >= 0xD0 && marker <= 0xD7)) continue;
    if (i + 1 >= len) return false;
    const size_t segment_len =
        (static_cast<size_t>(data[i]) << 8) | data[i + 1];
    if (segment_len < 2 || i + segment_len > len) return false;
    if (marker == 0xDA) {
      i += segment_len;
      for (; i + 1 < len; ++i) {
        if (data[i] == 0xFF && data[i + 1] == 0xD9) return true;
      }
      return false;
    }
    i += segment_len;
  }
  return false;
}

// The extra formats do not get the original tool's JPEG-specific EOI check,
// but a few cheap container checks preserve the same "never process a
// half-written file" property. A valid PNG ends with the IEND chunk; a RIFF
// size larger than the buffer means the WebP is truncated; BMP has its file
// size in the header. TIFF offsets are left to libtiff, which fails the decode
// on a truncated IFD.
bool HasCompletePng(const uint8_t* data, size_t len) {
  static const uint8_t kIend[12] = {0x00, 0x00, 0x00, 0x00, 'I', 'E',
                                    'N',  'D',  0xAE, 0x42, 0x60, 0x82};
  return data != nullptr && len >= sizeof(kIend) &&
         std::memcmp(data + len - sizeof(kIend), kIend, sizeof(kIend)) == 0;
}

bool HasCompleteWebp(const uint8_t* data, size_t len) {
  if (data == nullptr || len < 8) return false;
  const uint32_t riff_size = static_cast<uint32_t>(data[4]) |
                             (static_cast<uint32_t>(data[5]) << 8) |
                             (static_cast<uint32_t>(data[6]) << 16) |
                             (static_cast<uint32_t>(data[7]) << 24);
  return static_cast<size_t>(riff_size) <= len - 8;
}

bool HasCompleteBmp(const uint8_t* data, size_t len) {
  if (data == nullptr || len < 6) return false;
  const uint32_t file_size = static_cast<uint32_t>(data[2]) |
                             (static_cast<uint32_t>(data[3]) << 8) |
                             (static_cast<uint32_t>(data[4]) << 16) |
                             (static_cast<uint32_t>(data[5]) << 24);
  // A zero size is legal in some hand-written BMPs; let the decoder decide.
  return file_size == 0 || static_cast<size_t>(file_size) <= len;
}

// Decode with the same flags as the original executable. In particular
// IMREAD_IGNORE_ORIENTATION keeps EXIF-rotated photos in their stored
// orientation instead of silently rotating them.
bool DecodeJpeg(const uint8_t* jpg, size_t len, cv::Mat* out) {
  if (!LooksLikeJpeg(jpg, len)) return false;
  if (len > static_cast<size_t>(INT_MAX)) return false;
  if (!HasEndOfImage(jpg, len)) return false;

  cv::Mat buffer(1, static_cast<int>(len), CV_8UC1,
                 const_cast<uint8_t*>(jpg));
  *out = cv::imdecode(buffer,
                      cv::IMREAD_COLOR | cv::IMREAD_IGNORE_ORIENTATION);
  return !out->empty();
}

// Convert a decoded still image to 8-bit BGR. JPEG always takes the exact
// DecodeJpeg path above; the other formats are decoded unchanged so alpha can
// be composited over white instead of being silently dropped.
bool ToBgr(const cv::Mat& src, cv::Mat* out) {
  if (src.empty() || out == nullptr) return false;

  cv::Mat image;
  if (src.depth() == CV_16U) {
    // 16-bit PNG/TIFF is legal; map the full range to 8 bits.
    src.convertTo(image, CV_8U, 1.0 / 257.0);
  } else if (src.depth() == CV_8U) {
    image = src;
  } else {
    return false;
  }

  const int channels = image.channels();
  if (channels == 3) {
    *out = image;
    return true;
  }
  if (channels == 1) {
    cv::cvtColor(image, *out, cv::COLOR_GRAY2BGR);
    return true;
  }
  if (channels != 2 && channels != 4) return false;

  // Composite transparency over white. The per-pixel loop keeps peak memory
  // low for large photos; alpha is uncommon enough that vectorising this is
  // not worth the extra float buffers.
  cv::Mat bgr(image.rows, image.cols, CV_8UC3);
  for (int y = 0; y < image.rows; ++y) {
    const uint8_t* src_row = image.ptr<uint8_t>(y);
    uint8_t* dst_row = bgr.ptr<uint8_t>(y);
    for (int x = 0; x < image.cols; ++x) {
      const unsigned alpha = channels == 4 ? src_row[3] : src_row[1];
      const unsigned inverse = 255u - alpha;
      if (channels == 4) {
        dst_row[0] = static_cast<uint8_t>(
            (src_row[0] * alpha + 255u * inverse + 127u) / 255u);
        dst_row[1] = static_cast<uint8_t>(
            (src_row[1] * alpha + 255u * inverse + 127u) / 255u);
        dst_row[2] = static_cast<uint8_t>(
            (src_row[2] * alpha + 255u * inverse + 127u) / 255u);
        src_row += 4;
      } else {
        const uint8_t gray = static_cast<uint8_t>(
            (src_row[0] * alpha + 255u * inverse + 127u) / 255u);
        dst_row[0] = dst_row[1] = dst_row[2] = gray;
        src_row += 2;
      }
      dst_row += 3;
    }
  }
  *out = bgr;
  return true;
}

bool DecodeImage(const uint8_t* data, size_t len, ImageFormat format,
                 cv::Mat* out) {
  if (data == nullptr || len == 0 || len > static_cast<size_t>(INT_MAX)) {
    return false;
  }
  if (format == ImageFormat::kJpeg) return DecodeJpeg(data, len, out);

  if (format == ImageFormat::kPng && !HasCompletePng(data, len)) return false;
  if (format == ImageFormat::kWebp && !HasCompleteWebp(data, len)) return false;
  if (format == ImageFormat::kBmp && !HasCompleteBmp(data, len)) return false;

  cv::Mat buffer(1, static_cast<int>(len), CV_8UC1,
                 const_cast<uint8_t*>(data));
  // IMREAD_UNCHANGED is -1, whose bits include IMREAD_IGNORE_ORIENTATION;
  // keeping the stored orientation matches the original tool's behaviour.
  cv::Mat decoded = cv::imdecode(buffer, cv::IMREAD_UNCHANGED);
  if (decoded.empty()) return false;
  return ToBgr(decoded, out);
}

// Copy a detected face into the metadata mirrors.
void StoreFace(const Face& face) {
  g_face_x = face.x;
  g_face_y = face.y;
  g_face_w = face.w;
  g_face_h = face.h;
}

void StoreCrop(const CropBox& crop) {
  g_crop_x = crop.x;
  g_crop_y = crop.y;
  g_crop_w = crop.w;
  g_crop_h = crop.h;
}

}  // namespace

extern "C" {

// Allocator for input buffers passed in by JavaScript. Freed only through
// photo_free; output buffers are owned by this translation unit and must
// never be passed to photo_free.
uint8_t* photo_alloc(size_t len) {
  if (len == 0) return nullptr;
  return static_cast<uint8_t*>(std::malloc(len));
}

void photo_free(uint8_t* ptr, size_t len) {
  (void)len;
  std::free(ptr);
}

int photo_init_cascade(const uint8_t* xml, size_t len) {
  ClearError();
  g_cascade_ready = false;

  if (xml == nullptr || len == 0) {
    SetError("cascade init", "empty XML buffer");
    return 0;
  }

  try {
    FILE* file = std::fopen(kCascadePath, "wb");
    if (file == nullptr) {
      SetError("cascade init", "cannot open /cascade.xml in memory filesystem");
      return 0;
    }

    const size_t written = std::fwrite(xml, 1, len, file);
    const int close_status = std::fclose(file);
    if (written != len) {
      SetError("cascade init", "short write to /cascade.xml");
      return 0;
    }
    if (close_status != 0) {
      SetError("cascade init", "failed to close /cascade.xml");
      return 0;
    }

    // Reload into a fresh object so a failed re-init cannot leave a partially
    // configured classifier behind.
    g_cascade = cv::CascadeClassifier();
    if (!g_cascade.load(kCascadePath) || g_cascade.empty()) {
      SetError("cascade init", "CascadeClassifier::load failed");
      return 0;
    }

    g_cascade_ready = true;
    return 1;
  } catch (const cv::Exception& e) {
    SetError("cascade init", e.what());
    return 0;
  } catch (const std::exception& e) {
    SetError("cascade init", e.what());
    return 0;
  }
}

int photo_process(const uint8_t* data, size_t len) {
  ClearError();
  ResetMetadata();
  g_output.clear();

  try {
    const ImageFormat format = DetectFormat(data, len);
    if (format == ImageFormat::kUnsupported) return len < 2 ? 1 : 6;

    cv::Mat img;
    if (!DecodeImage(data, len, format, &img)) {
      return format == ImageFormat::kJpeg ? 1 : 6;
    }

    g_input_w = img.cols;
    g_input_h = img.rows;
    if (img.cols < kConfig.dst_w || img.rows < kConfig.dst_h) return 2;

    // imdecode returns a continuous matrix; cloning keeps the background
    // sampler's row-stride assumption valid for any input.
    if (!img.isContinuous()) img = img.clone();
    if (img.type() != CV_8UC3) {
      SetError("prepare", "decoded image is not 8-bit BGR");
      return -1;
    }

    const BgClass background =
        check_background(img.data, img.cols, img.rows, kConfig);
    g_bg_class = static_cast<int>(background);
    if (background == BgClass::Reject) return 3;

    if (!g_cascade_ready || g_cascade.empty()) {
      SetError("detect", "cascade classifier is not initialised");
      return -1;
    }

    cv::Mat gray;
    cv::cvtColor(img, gray, cv::COLOR_BGR2GRAY);

    std::vector<cv::Rect> detections;
    g_cascade.detectMultiScale(gray, detections, 1.1, 2,
                               cv::CASCADE_DO_CANNY_PRUNING,
                               cv::Size(30, 30));

    if (detections.empty()) return 5;

    std::vector<Face> faces;
    faces.reserve(detections.size());
    for (const cv::Rect& r : detections) {
      faces.push_back(Face{r.x, r.y, r.width, r.height});
    }

    const Face face = pick_widest(faces.data(), static_cast<int>(faces.size()));
    StoreFace(face);

    CropBox crop{};
    if (!compute_crop(face, img.cols, img.rows, kConfig, &crop)) return 4;

    // compute_crop already clamps; this guard turns an unexpected bad box
    // into a reportable internal error instead of an OpenCV assertion.
    if (crop.w <= 0 || crop.h <= 0 || crop.x < 0 || crop.y < 0 ||
        crop.x + crop.w > img.cols || crop.y + crop.h > img.rows) {
      SetError("crop", "computed crop box is outside the decoded image");
      return -1;
    }
    StoreCrop(crop);

    const cv::Mat roi =
        img(cv::Rect(crop.x, crop.y, crop.w, crop.h));
    cv::Mat resized;
    cv::resize(roi, resized, cv::Size(kConfig.dst_w, kConfig.dst_h), 0.0, 0.0,
               cv::INTER_LINEAR);

    // Two generation-loss passes: the original tool writes a high-quality
    // JPEG first and then re-encodes it at the delivery quality.
    const std::vector<int> high_quality{cv::IMWRITE_JPEG_QUALITY, 95};
    std::vector<uchar> intermediate;
    if (!cv::imencode(".jpg", resized, intermediate, high_quality)) {
      SetError("encode", "JPEG encode at quality 95 failed");
      return -1;
    }

    cv::Mat requantized_input(1, static_cast<int>(intermediate.size()),
                              CV_8UC1, intermediate.data());
    const cv::Mat regen =
        cv::imdecode(requantized_input,
                     cv::IMREAD_COLOR | cv::IMREAD_IGNORE_ORIENTATION);
    if (regen.empty()) {
      SetError("encode", "JPEG re-decode between encode passes failed");
      return -1;
    }

    const std::vector<int> delivery_quality{cv::IMWRITE_JPEG_QUALITY, 40};
    std::vector<uchar> encoded;
    if (!cv::imencode(".jpg", regen, encoded, delivery_quality)) {
      SetError("encode", "JPEG encode at quality 40 failed");
      return -1;
    }

    g_output.assign(encoded.begin(), encoded.end());
    // The marker lets the official upload path recognise output produced by
    // the original tool; it is appended verbatim after the JPEG stream.
    g_output.insert(g_output.end(), kTrailer, kTrailer + sizeof(kTrailer));

    g_output_w = regen.cols;
    g_output_h = regen.rows;
    return 0;
  } catch (const cv::Exception& e) {
    g_output.clear();
    SetError("photo_process", e.what());
    return -1;
  } catch (const std::exception& e) {
    g_output.clear();
    SetError("photo_process", e.what());
    return -1;
  }
}

const uint8_t* photo_output_ptr(void) { return g_output.data(); }

size_t photo_output_len(void) { return g_output.size(); }

const uint8_t* photo_error_ptr(void) {
  return reinterpret_cast<const uint8_t*>(g_error.data());
}

size_t photo_error_len(void) { return g_error.size(); }

int photo_face_x(void) { return g_face_x; }
int photo_face_y(void) { return g_face_y; }
int photo_face_w(void) { return g_face_w; }
int photo_face_h(void) { return g_face_h; }

int photo_crop_x(void) { return g_crop_x; }
int photo_crop_y(void) { return g_crop_y; }
int photo_crop_w(void) { return g_crop_w; }
int photo_crop_h(void) { return g_crop_h; }

int photo_input_w(void) { return g_input_w; }
int photo_input_h(void) { return g_input_h; }

int photo_output_w(void) { return g_output_w; }
int photo_output_h(void) { return g_output_h; }

int photo_bg_class(void) { return g_bg_class; }

int photo_test_decode(const uint8_t* data, size_t len) {
  ClearError();
  g_test_bgr.clear();
  g_test_bgr_w = 0;
  g_test_bgr_h = 0;

  try {
    const ImageFormat format = DetectFormat(data, len);
    cv::Mat img;
    if (format == ImageFormat::kUnsupported ||
        !DecodeImage(data, len, format, &img)) {
      SetError("test decode", "input is not a decodable image");
      return 0;
    }
    if (!img.isContinuous()) img = img.clone();

    g_test_bgr.assign(img.data,
                      img.data + static_cast<size_t>(img.total()) *
                                     img.elemSize());
    g_test_bgr_w = img.cols;
    g_test_bgr_h = img.rows;
    return 1;
  } catch (const cv::Exception& e) {
    g_test_bgr.clear();
    SetError("test decode", e.what());
    return 0;
  } catch (const std::exception& e) {
    g_test_bgr.clear();
    SetError("test decode", e.what());
    return 0;
  }
}

const uint8_t* photo_test_bgr_ptr(void) { return g_test_bgr.data(); }

int photo_test_bgr_w(void) { return g_test_bgr_w; }

int photo_test_bgr_h(void) { return g_test_bgr_h; }

}  // extern "C"
