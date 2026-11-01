# Build entry points for the photo tool. Replaces the former scripts/*.sh.
#
#   make bootstrap   install/activate emsdk 6.0.13, fetch OpenCV 4.10.0 source
#   make opencv      build the OpenCV wasm static libs (+ bundled libjpeg-turbo)
#   make wasm        compile cpp/ and link web/pkg/photo.js + photo.wasm
#   make build       bootstrap -> opencv -> wasm
#   make test        C++ logic tests, message wording tests, wasm integration
#   make logic-test  only the C++ logic tests (no OpenCV / wasm needed)
#   make serve       static server for the repo root on PORT (default 8000)
#   make dev         build, then serve
#   make clean       remove build/ and web/pkg/ (keeps .emsdk/ and vendor/)
#
# Paths can be overridden from the command line or the environment. Relative
# values are resolved with $(abspath) against the directory make runs in, so
# `make -C <repo>` behaves the same from anywhere.

SHELL := /bin/bash

EMSDK_DIR ?= .emsdk
OPENCV_SRC ?= vendor/opencv-4.10.0
OPENCV_BUILD ?= build/opencv
OPENCV_INSTALL ?= build/opencv-install
JPEG_LIB ?= $(OPENCV_BUILD)/3rdparty/lib/liblibjpeg-turbo.a
PORT ?= 8000
SERVE_ROOT ?= .
WEB_PKG ?= web/pkg

# `override` makes the abspath normalization apply even when the value came
# from the command line (command-line variables otherwise win over makefile
# assignments).
override EMSDK_DIR := $(abspath $(EMSDK_DIR))
override OPENCV_SRC := $(abspath $(OPENCV_SRC))
override OPENCV_BUILD := $(abspath $(OPENCV_BUILD))
override OPENCV_INSTALL := $(abspath $(OPENCV_INSTALL))
override JPEG_LIB := $(abspath $(JPEG_LIB))
override SERVE_ROOT := $(abspath $(SERVE_ROOT))
override WEB_PKG := $(abspath $(WEB_PKG))

EMSDK_VERSION := 6.0.13
OPENCV_VERSION := 4.10.0
NPROC ?= $(shell nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 2)

# emcc resolves node/python from .emsdk/.emscripten, so only the toolchain
# directories need to be on PATH.
export PATH := $(EMSDK_DIR)/upstream/emscripten:$(EMSDK_DIR)/upstream/bin:$(PATH)
export CC_wasm32_unknown_emscripten := emcc
export CXX_wasm32_unknown_emscripten := em++
export AR_wasm32_unknown_emscripten := $(EMSDK_DIR)/upstream/bin/llvm-ar

OPENCV_LIBS := \
	$(OPENCV_INSTALL)/lib/libopencv_objdetect.a \
	$(OPENCV_INSTALL)/lib/libopencv_calib3d.a \
	$(OPENCV_INSTALL)/lib/libopencv_features2d.a \
	$(OPENCV_INSTALL)/lib/libopencv_flann.a \
	$(OPENCV_INSTALL)/lib/libopencv_imgcodecs.a \
	$(OPENCV_INSTALL)/lib/libopencv_imgproc.a \
	$(OPENCV_INSTALL)/lib/libopencv_core.a

OPENCV_CMAKE_FLAGS := \
	-DCMAKE_BUILD_TYPE=Release \
	-DCMAKE_INSTALL_PREFIX="$(OPENCV_INSTALL)" \
	-DBUILD_LIST=core,imgproc,calib3d,features2d,flann,objdetect,imgcodecs \
	-DBUILD_SHARED_LIBS=OFF \
	-DBUILD_TESTS=OFF \
	-DBUILD_PERF_TESTS=OFF \
	-DBUILD_EXAMPLES=OFF \
	-DBUILD_DOCS=OFF \
	-DBUILD_PACKAGE=OFF \
	-DBUILD_opencv_apps=OFF \
	-DBUILD_opencv_js=OFF \
	-DBUILD_JAVA=OFF \
	-DBUILD_opencv_python2=OFF \
	-DBUILD_opencv_python3=OFF \
	-DWITH_IPP=OFF \
	-DWITH_ITT=OFF \
	-DWITH_OPENCL=OFF \
	-DWITH_CUDA=OFF \
	-DWITH_FFMPEG=OFF \
	-DWITH_GSTREAMER=OFF \
	-DWITH_JPEG=ON \
	-DBUILD_JPEG=ON \
	-DWITH_PNG=OFF \
	-DWITH_TIFF=OFF \
	-DWITH_WEBP=OFF \
	-DWITH_OPENJPEG=OFF \
	-DWITH_JASPER=OFF \
	-DWITH_OPENEXR=OFF \
	-DWITH_PROTOBUF=OFF \
	-DWITH_QUIRC=OFF \
	-DWITH_LAPACK=OFF \
	-DWITH_EIGEN=OFF \
	-DWITH_OPENMP=OFF \
	-DWITH_PTHREADS_PF=OFF \
	-DCV_ENABLE_INTRINSICS=OFF \
	-DOPENCV_ENABLE_NONFREE=OFF

# Everything that makes an existing build/opencv-install stale (source tree,
# toolchain checkout, flags, versions). Quotes are stripped because the value
# is written verbatim into the stamp file.
OPENCV_CONFIG_ID := opencv=$(OPENCV_VERSION) emsdk=$(EMSDK_VERSION) src=$(OPENCV_SRC) emsdk_dir=$(EMSDK_DIR) flags=$(subst ",,$(OPENCV_CMAKE_FLAGS))

EXPORTED_FUNCTIONS := _photo_alloc,_photo_free,_photo_init_cascade,_photo_process,_photo_output_ptr,_photo_output_len,_photo_error_ptr,_photo_error_len,_photo_face_x,_photo_face_y,_photo_face_w,_photo_face_h,_photo_crop_x,_photo_crop_y,_photo_crop_w,_photo_crop_h,_photo_input_w,_photo_input_h,_photo_output_w,_photo_output_h,_photo_bg_class,_photo_test_decode,_photo_test_bgr_ptr,_photo_test_bgr_w,_photo_test_bgr_h

# Destructive-removal guards. EMSDK_DIR, OPENCV_BUILD and OPENCV_INSTALL can
# all be overridden from the command line or the environment, so every target
# that deletes one runs the same checks first. The function text is embedded in
# each recipe instead of a helper script so the rules live in one place.
#
#   refuse_path <dir> <name>
#     never allows empty values, /, the repository root or its ancestors.
#   check_emsdk_dir <dir> <name>
#     only allows a missing dir, an empty dir, or an emsdk checkout
#     (contains emsdk and/or .git).
#   check_opencv_dir <dir> <name>
#     only allows a missing dir, an empty dir, or a CMake cache, our install
#     stamp, or OpenCV static libraries.
#   remove_emsdk_dir / remove_opencv_pair
#     validate first, then delete.
SAFE_RM_FUNCS = \
	refuse_path() { \
		local d="$$1" name="$$2"; \
		if [ -z "$$d" ]; then \
			echo "refusing to remove $$name: empty path" >&2; \
			exit 1; \
		fi; \
		d="$${d%/}"; \
		case "$$d" in \
			"" | "/") \
				echo "refusing to remove dangerous $$name=$$1" >&2; \
				exit 1;; \
		esac; \
		if [ "$$d" = "$(CURDIR)" ]; then \
			echo "refusing to remove $$name=$$1 (the repository root)" >&2; \
			exit 1; \
		fi; \
		case "$(CURDIR)/" in \
			"$$d"/*) \
				echo "refusing to remove $$name=$$1 (ancestor of the repository)" >&2; \
				exit 1;; \
		esac; \
	}; \
	dir_is_empty() { \
		local out; \
		[ -d "$$1" ] || return 1; \
		out=$$(ls -A "$$1" 2>/dev/null) || return 1; \
		[ -z "$$out" ]; \
	}; \
	check_emsdk_dir() { \
		local d="$$1" name="$$2"; \
		if [ ! -e "$$d" ]; then return 0; fi; \
		if [ ! -d "$$d" ]; then \
			echo "refusing to remove $$name=$$d (not a directory)" >&2; \
			exit 1; \
		fi; \
		if dir_is_empty "$$d" || [ -e "$$d/emsdk" ] || [ -e "$$d/.git" ]; then \
			return 0; \
		fi; \
		echo "refusing to remove $$name=$$d: not an emsdk checkout" >&2; \
		echo "Expected an empty directory or one containing emsdk/.git; remove it manually if that is really intended." >&2; \
		exit 1; \
	}; \
	check_opencv_dir() { \
		local d="$$1" name="$$2"; \
		if [ ! -e "$$d" ]; then return 0; fi; \
		if [ ! -d "$$d" ]; then \
			echo "refusing to remove $$name=$$d (not a directory)" >&2; \
			exit 1; \
		fi; \
		if dir_is_empty "$$d" || [ -f "$$d/CMakeCache.txt" ] || \
			[ -f "$$d/.opencv-config" ] || \
			ls "$$d"/libopencv_*.a "$$d"/lib/libopencv_*.a >/dev/null 2>&1; then \
			return 0; \
		fi; \
		echo "refusing to remove $$name=$$d: not an OpenCV build or install" >&2; \
		echo "Expected CMakeCache.txt, .opencv-config, libopencv_*.a, or an empty directory; remove it manually if that is really intended." >&2; \
		exit 1; \
	}; \
	remove_emsdk_dir() { \
		refuse_path "$$1" "$$2"; \
		check_emsdk_dir "$$1" "$$2"; \
		rm -rf -- "$$1"; \
	}; \
	remove_opencv_pair() { \
		refuse_path "$$1" "$$2"; \
		check_opencv_dir "$$1" "$$2"; \
		refuse_path "$$3" "$$4"; \
		check_opencv_dir "$$3" "$$4"; \
		rm -rf -- "$$1" "$$3"; \
	};

.DEFAULT_GOAL := build
.PHONY: bootstrap opencv wasm build test logic-test serve dev clean

bootstrap:
	@set -euo pipefail; \
	$(SAFE_RM_FUNCS) \
	if [ ! -x "$(EMSDK_DIR)/emsdk" ]; then \
		if [ -e "$(EMSDK_DIR)" ]; then \
			echo "==> Removing incomplete emsdk checkout: $(EMSDK_DIR)"; \
			remove_emsdk_dir "$(EMSDK_DIR)" "EMSDK_DIR"; \
		fi; \
		echo "==> Installing emsdk $(EMSDK_VERSION)"; \
		git clone --depth 1 https://github.com/emscripten-core/emsdk.git "$(EMSDK_DIR)"; \
	else \
		echo "==> emsdk checkout present, installing $(EMSDK_VERSION)"; \
	fi; \
	if [ ! -x "$(EMSDK_DIR)/emsdk" ]; then \
		echo "emsdk bootstrap failed: $(EMSDK_DIR)/emsdk is missing or not executable" >&2; \
		echo "Remove $(EMSDK_DIR) and rerun 'make bootstrap'." >&2; \
		exit 1; \
	fi; \
	"$(EMSDK_DIR)/emsdk" install "$(EMSDK_VERSION)"; \
	echo "==> Activating emsdk $(EMSDK_VERSION)"; \
	"$(EMSDK_DIR)/emsdk" activate "$(EMSDK_VERSION)"; \
	if [ -f "$(OPENCV_SRC)/CMakeLists.txt" ]; then \
		echo "==> OpenCV source already present: $(OPENCV_SRC)"; \
	else \
		_dst="$$(dirname "$(OPENCV_SRC)")"; \
		mkdir -p "$$_dst"; \
		echo "==> Downloading OpenCV $(OPENCV_VERSION) source"; \
		curl -fL "https://github.com/opencv/opencv/archive/refs/tags/$(OPENCV_VERSION).tar.gz" \
			-o "$$_dst/opencv-$(OPENCV_VERSION).tar.gz"; \
		tar xzf "$$_dst/opencv-$(OPENCV_VERSION).tar.gz" -C "$$_dst"; \
		rm -f "$$_dst/opencv-$(OPENCV_VERSION).tar.gz"; \
		if [ ! -f "$(OPENCV_SRC)/CMakeLists.txt" ]; then \
			echo "OpenCV source not found at $(OPENCV_SRC) after extraction" >&2; \
			echo "Set OPENCV_SRC to the extracted opencv-$(OPENCV_VERSION) directory." >&2; \
			exit 1; \
		fi; \
	fi; \
	echo "==> Bootstrap done"

opencv: bootstrap
	@set -euo pipefail; \
	$(SAFE_RM_FUNCS) \
	refuse_path "$(OPENCV_BUILD)" "OPENCV_BUILD"; \
	check_opencv_dir "$(OPENCV_BUILD)" "OPENCV_BUILD"; \
	refuse_path "$(OPENCV_INSTALL)" "OPENCV_INSTALL"; \
	check_opencv_dir "$(OPENCV_INSTALL)" "OPENCV_INSTALL"; \
	config_id='$(OPENCV_CONFIG_ID)'; \
	stamp="$(OPENCV_INSTALL)/.opencv-config"; \
	if [ -f "$$stamp" ]; then \
		stored=$$(cat "$$stamp"); \
		if [ "$$stored" != "$$config_id" ]; then \
			echo "==> OpenCV build configuration changed; rebuilding from scratch"; \
			echo "    was: $$stored"; \
			echo "    now: $$config_id"; \
			remove_opencv_pair "$(OPENCV_BUILD)" "OPENCV_BUILD" "$(OPENCV_INSTALL)" "OPENCV_INSTALL"; \
		fi; \
	fi; \
	if [ -f "$(OPENCV_BUILD)/CMakeCache.txt" ]; then \
		cached_src=$$(sed -n 's/^CMAKE_HOME_DIRECTORY:INTERNAL=//p' "$(OPENCV_BUILD)/CMakeCache.txt"); \
		if [ -n "$$cached_src" ] && [ "$$cached_src" != "$(OPENCV_SRC)" ]; then \
			echo "==> OpenCV build dir was configured for $$cached_src"; \
			echo "==> removing $(OPENCV_BUILD) and $(OPENCV_INSTALL)"; \
			remove_opencv_pair "$(OPENCV_BUILD)" "OPENCV_BUILD" "$(OPENCV_INSTALL)" "OPENCV_INSTALL"; \
		fi; \
	fi; \
	cached_cc=""; \
	for f in "$(OPENCV_BUILD)/CMakeFiles/"*/CMakeCCompiler.cmake; do \
		if [ -f "$$f" ]; then \
			cached_cc=$$(sed -n 's/^set(CMAKE_C_COMPILER "\(.*\)")/\1/p' "$$f" | head -n 1); \
			break; \
		fi; \
	done; \
	if [ -n "$$cached_cc" ] && [ "$$cached_cc" != "$(EMSDK_DIR)/upstream/emscripten/emcc" ]; then \
		echo "==> OpenCV build dir was compiled with $$cached_cc"; \
		echo "==> removing $(OPENCV_BUILD) and $(OPENCV_INSTALL)"; \
		remove_opencv_pair "$(OPENCV_BUILD)" "OPENCV_BUILD" "$(OPENCV_INSTALL)" "OPENCV_INSTALL"; \
	fi; \
	mkdir -p "$(OPENCV_BUILD)" "$(OPENCV_INSTALL)"; \
	echo "==> Configuring OpenCV $(OPENCV_VERSION) (Emscripten)"; \
	emcmake cmake -S "$(OPENCV_SRC)" -B "$(OPENCV_BUILD)" -G Ninja \
		$(OPENCV_CMAKE_FLAGS); \
	echo "==> Building OpenCV"; \
	cmake --build "$(OPENCV_BUILD)" --parallel $(NPROC); \
	echo "==> Installing OpenCV"; \
	cmake --install "$(OPENCV_BUILD)"; \
	missing=""; \
	for lib in $(OPENCV_LIBS) "$(JPEG_LIB)"; do \
		[ -f "$$lib" ] || missing="$$missing $$lib"; \
	done; \
	if [ -n "$$missing" ]; then \
		echo "OpenCV install incomplete, missing:$$missing" >&2; \
		echo "Remove $(OPENCV_BUILD) and $(OPENCV_INSTALL), then rerun 'make opencv'." >&2; \
		exit 1; \
	fi; \
	printf '%s\n' "$$config_id" > "$$stamp"; \
	echo "OpenCV wasm install: $(OPENCV_INSTALL)"; \
	find "$(OPENCV_INSTALL)/lib" -maxdepth 1 -name '*.a' -exec ls -lh {} +

wasm: opencv
	@set -euo pipefail; \
	for f in "$(CURDIR)/cpp/photo_logic.cpp" "$(CURDIR)/cpp/photo_tool.cpp"; do \
		if [ ! -f "$$f" ]; then \
			echo "missing source: $$f" >&2; \
			exit 1; \
		fi; \
	done; \
	if [ ! -f "$(JPEG_LIB)" ]; then \
		echo "JPEG static library not found: $(JPEG_LIB)" >&2; \
		echo "Run 'make opencv' and check JPEG_LIB." >&2; \
		exit 1; \
	fi; \
	for lib in $(OPENCV_LIBS); do \
		if [ ! -f "$$lib" ]; then \
			echo "OpenCV wasm library missing: $$lib" >&2; \
			echo "Run 'make opencv' first." >&2; \
			exit 1; \
		fi; \
	done; \
	mkdir -p "$(WEB_PKG)"; \
	echo "==> em++ link"; \
	em++ -O3 -std=c++17 -fexceptions -sDISABLE_EXCEPTION_CATCHING=0 \
		-I"$(OPENCV_INSTALL)/include/opencv4" \
		"$(CURDIR)/cpp/photo_logic.cpp" "$(CURDIR)/cpp/photo_tool.cpp" \
		-Wl,--start-group \
			$(OPENCV_LIBS) \
			"$(JPEG_LIB)" \
		-Wl,--end-group \
		-o "$(WEB_PKG)/photo.js" \
		-sMODULARIZE=1 \
		-sEXPORT_NAME=createPhotoModule \
		-sEXPORT_ES6=1 \
		-sENVIRONMENT=web,worker,node \
		-sALLOW_MEMORY_GROWTH=1 \
		-sINITIAL_MEMORY=64MB \
		-sSTACK_SIZE=5MB \
		-sFILESYSTEM=1 \
		-sUSE_ZLIB=1 \
		-sEXPORTED_FUNCTIONS=$(EXPORTED_FUNCTIONS) \
		-sEXPORTED_RUNTIME_METHODS=HEAPU8; \
	echo "==> outputs"; \
	ls -lh "$(WEB_PKG)"

build: wasm

logic-test:
	@mkdir -p "$(CURDIR)/build"
	c++ -std=c++17 -O2 -I"$(CURDIR)/cpp" "$(CURDIR)/cpp/photo_logic.cpp" "$(CURDIR)/tests/logic_test.cpp" -o "$(CURDIR)/build/logic_test"
	"$(CURDIR)/build/logic_test"

test: logic-test wasm
	node "$(CURDIR)/tests/messages_test.mjs"
	node "$(CURDIR)/tests/run_wasm.mjs"

serve:
	python3 "$(CURDIR)/scripts/serve.py" $(PORT) --root "$(SERVE_ROOT)"

dev: build
	python3 "$(CURDIR)/scripts/serve.py" $(PORT) --root "$(SERVE_ROOT)"

clean:
	@set -euo pipefail; \
	$(SAFE_RM_FUNCS) \
	for d in "$(CURDIR)/build" "$(WEB_PKG)"; do \
		refuse_path "$$d" "clean target"; \
	done; \
	rm -rf -- "$(CURDIR)/build" "$(WEB_PKG)"
