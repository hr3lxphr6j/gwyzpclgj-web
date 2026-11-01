#include "photo_logic.h"

#include <algorithm>
#include <cmath>
#include <limits>

// FF 02 00 08 followed by ASCII "gjgwy2". Appended verbatim after the JPEG.
const uint8_t kTrailer[10] = {0xFF, 0x02, 0x00, 0x08, 0x67,
                              0x6A, 0x67, 0x77, 0x79, 0x32};

// Defaults mirror the verified photo.ini (i/s/blue_h) plus the constants that
// the original executable hard-codes (dst size, ratio window, crop ratio).
const PhotoConfig kConfig{};

namespace {

constexpr double kPi = 3.14159265358979323846;
constexpr double kTwoPi = 2.0 * kPi;

double NaN() { return std::numeric_limits<double>::quiet_NaN(); }

// Hue in radians [0, 2*pi]. Returns NaN when the denominator degenerates
// (neutral gray), which the classification step treats as a rejection.
double hue_of(double r, double g, double b) {
  const double d1 = r - g;
  const double d2 = r - b;
  const double d3 = g - b;
  const double num = (d1 + d2) / 2.0;
  const double den2 = d1 * d1 + d2 * d3;
  if (den2 <= 0.0) return NaN();
  double cosv = num / std::sqrt(den2);
  cosv = std::max(-1.0, std::min(1.0, cosv));
  double hue = std::acos(cosv);
  if (g < b) hue = kTwoPi - hue;
  return hue;
}

// Original saturation metric: 1 - 3*min(r,g,b)/(r+g+b).
double saturation_metric(double r, double g, double b) {
  const double s = r + g + b;
  if (s <= 0.0) return NaN();
  return 1.0 - 3.0 * std::min(r, std::min(g, b)) / s;
}

// Mean of the 3x3 patch centered at (cx, cy), clamped to the image like the
// reference pipeline does. For valid inputs (>= 295x413) nothing is clamped,
// so the divisor is always 9; dividing by the actual patch area keeps the
// clamped path identical to the reference slice mean.
void patch_mean(const uint8_t* bgr, int w, int h, int cx, int cy, double* out_r,
                double* out_g, double* out_b) {
  int x0 = cx - 1;
  int y0 = cy - 1;
  int x1 = x0 + 3;
  int y1 = y0 + 3;
  x0 = std::max(0, std::min(x0, w - 1));
  y0 = std::max(0, std::min(y0, h - 1));
  x1 = std::max(x0 + 1, std::min(x1, w));
  y1 = std::max(y0 + 1, std::min(y1, h));

  double sum_b = 0.0, sum_g = 0.0, sum_r = 0.0;
  const size_t stride = static_cast<size_t>(w) * 3;
  for (int y = y0; y < y1; ++y) {
    const uint8_t* row = bgr + static_cast<size_t>(y) * stride;
    for (int x = x0; x < x1; ++x) {
      sum_b += row[static_cast<size_t>(x) * 3 + 0];
      sum_g += row[static_cast<size_t>(x) * 3 + 1];
      sum_r += row[static_cast<size_t>(x) * 3 + 2];
    }
  }

  const double count = static_cast<double>((x1 - x0) * (y1 - y0));
  // Normalize each channel mean by 255.0 (divide by count first).
  *out_r = sum_r / count / 255.0;
  *out_g = sum_g / count / 255.0;
  *out_b = sum_b / count / 255.0;
}

}  // namespace

int round_half_even(double v) {
  // Default floating-point rounding mode is FE_TONEAREST (half to even), which
  // is what the original x87 _ftol conversion does.
  return static_cast<int>(std::nearbyint(v));
}

int trunc_to_zero(double v) { return static_cast<int>(std::trunc(v)); }

BgClass classify_patch(double r, double g, double b, const PhotoConfig& cfg) {
  const double i = (r + g + b) / 3.0;
  if (i < cfg.i_min) return BgClass::Reject;

  const double d2 = saturation_metric(r, g, b);

  // White background: bright enough and nearly neutral.
  if (i >= cfg.i_max && d2 <= cfg.s_min) return BgClass::White;

  // Blue background: hue window plus enough saturation. Written as a negated
  // conjunction so a NaN hue (neutral gray) falls through to Reject.
  const double hue = hue_of(r, g, b);
  if (!(cfg.blue_h_min <= hue && hue <= cfg.blue_h_max)) return BgClass::Reject;
  if (d2 < cfg.s_max) return BgClass::Reject;
  return BgClass::Blue;
}

BgClass check_background(const uint8_t* bgr, int w, int h,
                         const PhotoConfig& cfg) {
  if (bgr == nullptr || w <= 0 || h <= 0) return BgClass::Reject;

  const int centers_x[3] = {w / 10, w / 10, w - w / 10};
  const int centers_y[3] = {h / 10, h / 4, h / 6};

  BgClass codes[3];
  for (int i = 0; i < 3; ++i) {
    double r = 0.0, g = 0.0, b = 0.0;
    patch_mean(bgr, w, h, centers_x[i], centers_y[i], &r, &g, &b);
    codes[i] = classify_patch(r, g, b, cfg);
  }

  // All three blocks must agree, otherwise the background is rejected.
  if (codes[0] != codes[1] || codes[0] != codes[2]) return BgClass::Reject;
  return codes[0];
}

Face pick_widest(const Face* faces, int n) {
  if (faces == nullptr || n <= 0) return Face{0, 0, 0, 0};
  Face best = faces[0];
  for (int i = 1; i < n; ++i) {
    // Strict '>' keeps the first detection on equal widths.
    if (faces[i].w > best.w) best = faces[i];
  }
  return best;
}

bool compute_crop(const Face& face, int img_w, int img_h,
                  const PhotoConfig& cfg, CropBox* out) {
  if (out == nullptr || img_w <= 0 || img_h <= 0) return false;

  const int fx = face.x;
  const int fy = face.y;
  const int fw = face.w;
  const int fh = face.h;

  // Gate: face width / image width.
  if (fw / static_cast<double>(img_w) < cfg.min_face_ratio) return false;

  int crop_w = round_half_even(fw * cfg.crop_ratio);
  int crop_h =
      round_half_even(static_cast<double>(crop_w) * cfg.dst_h / cfg.dst_w + 0.5);

  // Center the crop on the face (truncate toward zero, as in the binary).
  int x0 = fx - trunc_to_zero((crop_w - fw) / 2.0);
  int y0 = fy - trunc_to_zero((crop_h - fh) / 2.0);

  // Boundary clamping, matching the original executable.
  if (crop_w > img_w) {
    x0 = 0;
    crop_w = img_w;
  } else {
    if (x0 < 0) x0 = 0;
    if (x0 + crop_w > img_w) x0 = img_w - crop_w;
  }
  if (crop_h > img_h) {
    y0 = 0;
    crop_h = img_h;
  } else {
    if (y0 < 0) y0 = 0;
    if (y0 + crop_h > img_h) y0 = img_h - crop_h;
  }

  // Ratio correction compensating for clamping-induced distortion.
  const double r = (static_cast<double>(crop_h) * cfg.dst_w) /
                   (static_cast<double>(crop_w) * cfg.dst_h);
  if (r < 0.9) {
    const int nw =
        round_half_even(static_cast<double>(crop_h) * cfg.dst_w / cfg.dst_h);
    x0 += trunc_to_zero((crop_w - nw) / 2.0);
    crop_w = nw;
  } else if (r > 1.1) {
    const int nh =
        round_half_even(static_cast<double>(crop_w) * cfg.dst_h / cfg.dst_w);
    y0 += trunc_to_zero((crop_h - nh) / 2.0);
    crop_h = nh;
  }

  // Centering check. Negated conjunction so NaN fails the check.
  const double rx = (fx - x0) / static_cast<double>(crop_w);
  const double ry = (fy - y0) / static_cast<double>(crop_h);
  if (!(cfg.ratio_x_min <= rx && rx <= cfg.ratio_x_max)) return false;
  if (!(cfg.ratio_y_min <= ry && ry <= cfg.ratio_y_max)) return false;

  // Safety clamp after ratio correction (present in the reference pipeline,
  // absent in the original executable). Prevents out-of-bounds ROI reads.
  crop_w = std::max(1, std::min(crop_w, img_w));
  crop_h = std::max(1, std::min(crop_h, img_h));
  x0 = std::max(0, std::min(x0, img_w - crop_w));
  y0 = std::max(0, std::min(y0, img_h - crop_h));

  out->x = x0;
  out->y = y0;
  out->w = crop_w;
  out->h = crop_h;
  return true;
}
