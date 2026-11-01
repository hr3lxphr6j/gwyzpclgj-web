// Pure business logic for the photo tool: no OpenCV, no I/O.
//
// This is a faithful implementation of the reverse-engineered behavior:
// three 3x3 background samples with hue/saturation classification, and a
// 1.618x face crop with boundary clamping and centering checks.
// Values match the verified photo.ini and the constants used by the original tool.

#ifndef PHOTO_LOGIC_H_
#define PHOTO_LOGIC_H_

#include <cstdint>

struct PhotoConfig {
  double i_min = 0.1;
  double i_max = 0.7;
  double s_min = 0.05;
  double s_max = 0.1;
  double blue_h_min = 2.5;
  double blue_h_max = 4.5;
  int dst_w = 295;
  int dst_h = 413;
  double ratio_x_min = 0.0;
  double ratio_x_max = 0.5;
  double ratio_y_min = 0.0;
  double ratio_y_max = 0.5;
  double crop_ratio = 1.61812297734628;
  double min_face_ratio = 0.32;
};

// Face rectangle as returned by Haar detection (integer pixels).
struct Face {
  int x, y, w, h;
};

// Crop rectangle in source-image pixels.
struct CropBox {
  int x, y, w, h;
};

// Decision codes match the original executable: 0 = white pass,
// 1 = blue pass, 3 = background rejected.
enum class BgClass { White = 0, Blue = 1, Reject = 3 };

// Round half to even (x87 _ftol with the default FE_TONEAREST mode).
int round_half_even(double v);

// Truncate toward zero (the cdq/sub/sar sequence in the original binary).
int trunc_to_zero(double v);

// Classify one normalized RGB patch ([0,1] components).
BgClass classify_patch(double r, double g, double b, const PhotoConfig& cfg);

// Classify a BGR8 image (row-major, stride = w * 3). Three 3x3 blocks are
// sampled at (W/10,H/10), (W/10,H/4), (W-W/10,H/6); all three must agree.
BgClass check_background(const uint8_t* bgr, int w, int h,
                         const PhotoConfig& cfg);

// Widest face wins; ties keep the earlier detection. Returns a zero rect when
// the input is empty.
Face pick_widest(const Face* faces, int n);

// Derive the 295:413 crop box. Returns false when the face is too small or the
// centering check fails (both are error 4 in the original tool).
bool compute_crop(const Face& face, int img_w, int img_h,
                  const PhotoConfig& cfg, CropBox* out);

// 10-byte marker appended after the encoded JPEG: FF 02 00 08 "gjgwy2".
extern const uint8_t kTrailer[10];

// photo.ini values + hard-coded constants (see design doc section 3.2).
extern const PhotoConfig kConfig;

#endif  // PHOTO_LOGIC_H_
