// Pure-logic unit tests for photo_logic.{h,cpp}.
//
// Deliberately uses a CHECK macro instead of assert(): assert() disappears
// under -DNDEBUG, which would let the whole suite pass silently.
//
// Build & run (from the repo root):
//   mkdir -p build
//   c++ -std=c++17 -O2 -Icpp cpp/photo_logic.cpp tests/logic_test.cpp -o build/logic_test
//   ./build/logic_test
//
// Expected: "logic tests: OK", exit code 0.
//
// The color-card expectations come from the original Windows executable,
// using the verified photo.ini values:
// i_min=.1 i_max=.7 s_min=.05 s_max=.1 blue_h=2.5..4.5.

#include <cstdio>
#include <cstring>
#include <vector>

#include "photo_logic.h"

static int g_checks = 0;
static int g_failed = 0;

#define CHECK(cond)                                                        \
  do {                                                                     \
    ++g_checks;                                                            \
    if (!(cond)) {                                                         \
      std::fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
      ++g_failed;                                                          \
    }                                                                      \
  } while (0)

// ---------------------------------------------------------------------------
// Background classification: 20 color cards
// ---------------------------------------------------------------------------

static BgClass classify_rgb(int r, int g, int b) {
  return classify_patch(r / 255.0, g / 255.0, b / 255.0, kConfig);
}

static void check_color(int r, int g, int b, bool expect_pass) {
  ++g_checks;
  const BgClass got = classify_rgb(r, g, b);
  const bool pass = (got != BgClass::Reject);
  if (pass != expect_pass) {
    std::fprintf(stderr,
                 "FAIL color (%d,%d,%d): expected %s, got code %d\n", r, g, b,
                 expect_pass ? "PASS" : "FAIL", static_cast<int>(got));
    ++g_failed;
  }
}

static void test_color_cards() {
  // FAIL cards (background rejected).
  check_color(0, 0, 0, false);
  check_color(40, 40, 40, false);
  check_color(80, 80, 80, false);
  check_color(128, 128, 128, false);
  check_color(200, 60, 60, false);
  check_color(60, 180, 90, false);
  check_color(240, 220, 60, false);
  check_color(255, 0, 0, false);
  check_color(255, 220, 120, false);
  check_color(200, 220, 240, false);
  check_color(170, 170, 170, false);

  // PASS cards (white or blue background).
  check_color(180, 180, 180, true);
  check_color(220, 220, 220, true);
  check_color(255, 255, 255, true);
  check_color(250, 246, 240, true);
  check_color(240, 242, 250, true);
  check_color(67, 142, 219, true);
  check_color(0, 0, 255, true);
  check_color(250, 250, 240, true);
  check_color(150, 180, 220, true);

  // A few exact classes, pinned by the thresholds and hue window.
  CHECK(classify_rgb(180, 180, 180) == BgClass::White);  // I=0.706 >= i_max
  CHECK(classify_rgb(255, 255, 255) == BgClass::White);
  CHECK(classify_rgb(67, 142, 219) == BgClass::Blue);    // standard blue
  CHECK(classify_rgb(0, 0, 255) == BgClass::Blue);       // hue 4.19 rad
}

// ---------------------------------------------------------------------------
// check_background on solid synthetic BGR images
// ---------------------------------------------------------------------------

static std::vector<uint8_t> solid_bgr(int w, int h, uint8_t b, uint8_t g,
                                      uint8_t r) {
  std::vector<uint8_t> px(static_cast<size_t>(w) * h * 3);
  for (size_t i = 0; i < px.size(); i += 3) {
    px[i + 0] = b;
    px[i + 1] = g;
    px[i + 2] = r;
  }
  return px;
}

static void test_check_background() {
  const int w = 400, h = 600;

  const std::vector<uint8_t> white = solid_bgr(w, h, 255, 255, 255);
  CHECK(check_background(white.data(), w, h, kConfig) == BgClass::White);

  const std::vector<uint8_t> blue = solid_bgr(w, h, 255, 0, 0);  // BGR pure blue
  CHECK(check_background(blue.data(), w, h, kConfig) == BgClass::Blue);

  const std::vector<uint8_t> red = solid_bgr(w, h, 0, 0, 255);  // BGR pure red
  CHECK(check_background(red.data(), w, h, kConfig) == BgClass::Reject);

  // All three sample blocks must agree: a blue image with a white 3x3 patch at
  // the first sample center is inconsistent and must be rejected.
  std::vector<uint8_t> mixed = blue;
  for (int y = 59; y <= 61; ++y) {
    for (int x = 39; x <= 41; ++x) {
      uint8_t* p = &mixed[(static_cast<size_t>(y) * w + x) * 3];
      p[0] = p[1] = p[2] = 255;
    }
  }
  CHECK(check_background(mixed.data(), w, h, kConfig) == BgClass::Reject);
}

// ---------------------------------------------------------------------------
// Rounding helpers
// ---------------------------------------------------------------------------

static void test_rounding() {
  // round-half-to-even (x87 _ftol default / std::nearbyint + FE_TONEAREST).
  CHECK(round_half_even(2.5) == 2);
  CHECK(round_half_even(3.5) == 4);
  CHECK(round_half_even(-2.5) == -2);
  CHECK(round_half_even(0.5) == 0);
  CHECK(round_half_even(1.5) == 2);
  CHECK(round_half_even(-0.5) == 0);
  CHECK(round_half_even(566.343042071198) == 566);

  // Truncation toward zero (cdq/sub/sar), not floor.
  CHECK(trunc_to_zero(-2.5) == -2);
  CHECK(trunc_to_zero(2.5) == 2);
  CHECK(trunc_to_zero(-0.4) == 0);
  CHECK(trunc_to_zero(68.5) == 68);
}

// ---------------------------------------------------------------------------
// compute_crop
// ---------------------------------------------------------------------------

static void check_crop(const char* label, int fx, int fy, int fw, int fh,
                       int img_w, int img_h, bool want_ok, int ex, int ey,
                       int ew, int eh) {
  ++g_checks;
  CropBox box{-9999, -9999, -9999, -9999};
  const Face face{fx, fy, fw, fh};
  const bool ok = compute_crop(face, img_w, img_h, kConfig, &box);
  if (ok != want_ok) {
    std::fprintf(stderr, "FAIL crop %s: expected ok=%d, got ok=%d\n", label,
                 want_ok, ok);
    ++g_failed;
    return;
  }
  if (ok && (box.x != ex || box.y != ey || box.w != ew || box.h != eh)) {
    std::fprintf(stderr,
                 "FAIL crop %s: expected (%d,%d,%d,%d), got (%d,%d,%d,%d)\n",
                 label, ex, ey, ew, eh, box.x, box.y, box.w, box.h);
    ++g_failed;
  }
}

static void test_compute_crop() {
  // Plain 295:413 crop, everything fits.
  check_crop("base", 400, 500, 350, 300, 1000, 1500, true, 292, 254, 566, 793);

  // Negative x0/y0 get clamped to 0; crop size stays under the image.
  check_crop("clamp-origin", 10, 10, 140, 140, 400, 600, true, 0, 0, 227,
             318);

  // r < 0.9: height was clamped to the image, narrow the crop and re-center.
  check_crop("ratio-low", 400, 100, 350, 300, 1000, 600, true, 360, 0, 429,
             600);

  // r > 1.1: width was clamped to the image, shrink the height around the face.
  check_crop("ratio-high", 0, 200, 70, 70, 100, 1000, true, 0, 165, 100, 140);

  // Face too small relative to image width (0.30 < 0.32).
  check_crop("face-too-small", 0, 0, 300, 300, 1000, 1500, false, 0, 0, 0, 0);

  // Centering check fails: rx = (900-434)/566 = 0.823 > 0.5.
  check_crop("centering", 900, 500, 350, 350, 1000, 1000, false, 0, 0, 0, 0);
}

// ---------------------------------------------------------------------------
// pick_widest
// ---------------------------------------------------------------------------

static void test_pick_widest() {
  const Face faces[3] = {{0, 0, 100, 100}, {10, 10, 200, 200},
                         {20, 20, 200, 200}};
  const Face widest = pick_widest(faces, 3);
  // Equal widths keep the earlier detection (strict '>' comparison).
  CHECK(widest.x == 10);
  CHECK(widest.y == 10);
  CHECK(widest.w == 200);
  CHECK(widest.h == 200);

  const Face only = pick_widest(faces, 1);
  CHECK(only.x == 0 && only.y == 0 && only.w == 100 && only.h == 100);
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

static void test_constants() {
  const uint8_t expected[10] = {0xFF, 0x02, 0x00, 0x08, 0x67,
                                0x6A, 0x67, 0x77, 0x79, 0x32};
  CHECK(std::memcmp(kTrailer, expected, sizeof expected) == 0);

  // Defaults come from the verified photo.ini plus the hard-coded constants.
  CHECK(kConfig.i_min == 0.1);
  CHECK(kConfig.i_max == 0.7);
  CHECK(kConfig.s_min == 0.05);
  CHECK(kConfig.s_max == 0.1);
  CHECK(kConfig.blue_h_min == 2.5);
  CHECK(kConfig.blue_h_max == 4.5);
  CHECK(kConfig.dst_w == 295);
  CHECK(kConfig.dst_h == 413);
  CHECK(kConfig.ratio_x_min == 0.0);
  CHECK(kConfig.ratio_x_max == 0.5);
  CHECK(kConfig.ratio_y_min == 0.0);
  CHECK(kConfig.ratio_y_max == 0.5);
  CHECK(kConfig.crop_ratio == 1.61812297734628);
  CHECK(kConfig.min_face_ratio == 0.32);
}

int main() {
  test_color_cards();
  test_check_background();
  test_rounding();
  test_compute_crop();
  test_pick_widest();
  test_constants();

  if (g_failed != 0) {
    std::fprintf(stderr, "logic tests: %d/%d checks FAILED\n", g_failed,
                 g_checks);
    return 1;
  }
  std::printf("logic tests: OK\n");
  return 0;
}
