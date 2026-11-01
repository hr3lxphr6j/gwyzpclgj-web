# 国考报名照片 Web 工具

**在线使用：** <https://hr3lxphr6j.github.io/gwyzpclgj-web/>  
**源码仓库：** <https://github.com/hr3lxphr6j/gwyzpclgj-web>

![界面](docs/screenshot.png)

静态网页版「报名照片处理工具」：在浏览器本地完成背景校验、人脸检测、自动裁切、
295×413 缩放、JPEG 编码与尾标记追加，并直接下载 `报名照片.jpg`。所有照片处理都在
本机完成，不上传图片、没有后端。

本仓库是对桌面版 `照片处理工具.exe` 的行为复刻：错误码、提示文案、配置参数、裁切
公式、编码流程与 10 字节尾标记都按原工具实现。网页 UI 为原程序没有的交付形态，但
处理结果保持一致。

## 严格复刻的行为

### 输入与错误码

只接受 JPEG（前两字节为 `FF D8`），且要求文件含完整的 EOI 标记。错误码与提示文案
逐字一致（全角标点也是契约的一部分）：

| 码 | 触发条件 | 提示语 |
|---|---|---|
| 1 | 不是 `FF D8` 开头，或 JPEG 解码失败，或文件被截断（缺少 EOI） | 打开照片文件类型不是JPG/JPEG格式，请选择JPG/JPEG格式照片文件。 |
| 2 | 解码后宽 < 295 或高 < 413 | 打开照片文件像素数低。请选择高于或符合像素数要求的照片文件。 |
| 3 | 背景判定不通过 | 打开照片文件背景不符合要求。请选择白色或蓝色背景照片文件。 |
| 4 | 人脸宽度 / 图宽 < 0.32，或裁切框居中校验失败 | 打开照片文件人像头部比例不符合要求。请选择头部比例适当的照片文件。 |
| 5 | Haar 级联未检出人脸 | 打开照片文件不符合要求。请选择正面人像标准证件照片文件。 |
| 0 | 成功 | 无 |

错误 1 中的 EOI 完整性检查是**相对原 exe 的安全偏差**：原 exe 可能部分解码截断
文件，本工具直接拒绝，避免把半张图当成正常照片处理。

### 背景判定

取样中心（整数截断除法）：

```
(W/10, H/10), (W/10, H/4), (W - W/10, H/6)
```

每个中心取 3×3 像素，分别累加 B/G/R 并除以 `9*255` 归一化。单块用
`s = r + g + b`、`I = s / 3`、`D2 = 1 - 3*min(r,g,b)/s` 分类：

- `I < 0.1` → 不通过
- `I >= 0.7` 且 `D2 <= 0.05` → 白底
- 色相必须在 `[2.5, 4.5]` 弧度（NaN 视为不通过）
- `D2 < 0.1` → 不通过，否则为蓝底

三块结果必须完全一致，否则整体不通过；白底与蓝底都视为通过。参数来自已验证的
`photo.ini`，硬编码在 `cpp/photo_logic.h`。

### 人脸与裁切

1. 用 `IMREAD_COLOR | IMREAD_IGNORE_ORIENTATION` 解码为 BGR（**不应用 EXIF 方向**）。
2. 转灰度后加载仓库自带的 `haarcascade_frontalface_alt2.xml`，调用
   `detectMultiScale(gray, faces, 1.1, 2, CASCADE_DO_CANNY_PRUNING, Size(30,30))`。
3. 取**宽度最大**的人脸；宽度相等时保留先检出的一张。
4. 人脸宽 / 图宽 `< 0.32` → 错误 4。
5. 裁切框：

```
crop_w = round_half_even(face_w * 1.61812297734628)
crop_h = round_half_even(crop_w * 413 / 295 + 0.5)
x0 = face_x - trunc((crop_w - face_w) / 2)
y0 = face_y - trunc((crop_h - face_h) / 2)
```

再做边界钳制（与参考实现一致，越界时贴边而不是崩溃）；若裁切框宽高比偏离 295:413
超过 ±10%，按目标比例修正一次；然后要求**人脸框左上角**（`fx`/`fy`，不是人脸中心）
在裁切框内的归一化位置落在 `[0, 0.5]`，否则错误 4；最后再做一次安全钳制
（**原 exe 无此步**，用于保证 ROI 不越界）：

```
rx = (fx - x0) / crop_w
ry = (fy - y0) / crop_h
0 <= rx <= 0.5   且   0 <= ry <= 0.5
```

舍入使用 **round-half-even**（对应原程序 x87 `_ftol` 的默认舍入），`trunc` 为向零截断；
两者都在 `cpp/photo_logic.cpp` 中实现并有单元测试。

### 缩放、编码与尾标记

1. 裁切 ROI 用 `INTER_LINEAR` 缩放到 **295×413**。
2. 以质量 **95** 编码 JPEG，再解码，再以质量 **40** 重新编码（与原工具的两代有损流程一致）。
3. 在文件末尾追加 **10 字节**：`FF 02 00 08 67 6A 67 77 79 32`。
4. 下载文件名固定为 `报名照片.jpg`。

## 技术栈

- C++17 + OpenCV 4.10.0（`core`、`imgproc`、`calib3d`、`features2d`、`flann`、
  `objdetect`、`imgcodecs`，含内置 libjpeg-turbo），由 Emscripten 6.0.13（
  `wasm32-unknown-emscripten`）编译为 wasm 静态库。
- 原生 HTML / CSS / ES modules，无前端框架；除 Cloudflare Web Analytics 脚本外
  无 CDN 资源。
- HTML 主线程 + module worker；worker 内通过 C ABI 调用 wasm，不使用 wasm-bindgen。
- Node.js 20+（仅测试）、Python 3.10+（本地静态服务器）。

## 目录结构

```
Makefile             构建入口（bootstrap/opencv/wasm/build/test/logic-test/serve）
cpp/
  photo_logic.h       配置常量、纯函数声明（不依赖 OpenCV）
  photo_logic.cpp     背景判定、裁切公式、舍入、尾标记
  photo_tool.cpp      C ABI + OpenCV 解码/检测/缩放/编码
web/
  index.html          页面结构
  app.js              主线程 UI、状态机、预览与下载
  worker.js           module worker：加载 wasm + 级联，执行处理
  messages.js         错误码 → 逐字文案（UI 与测试共用）
  style.css
  assets/haarcascade_frontalface_alt2.xml
  pkg/                wasm 构建产物（构建生成，不进 git）
  .nojekyll
scripts/
  serve.py            正确的 .wasm MIME 静态服务器（保留；由 make serve 调用）
tests/
  logic_test.cpp      纯 C++ 单元测试（不依赖 OpenCV/wasm）
  messages_test.mjs   5 条用户文案的逐字校验
  run_wasm.mjs        Node wasm 集成测试
  jpeg.mjs            JPEG 结构/SSIM 测试辅助
  fixtures/           8 张回归照片、边界输入与 manifest.json
  reference/          p2 的参考输出（DQT/SSIM 基准）
docs/screenshot.png   界面截图
.github/workflows/deploy.yml
```

`.emsdk/`、`vendor/`、`build/`、`web/pkg/` 都被 git 忽略，由 make 目标生成。

## 架构

```
index.html + app.js（主线程）
  文件选择 / 拖拽 / 状态 / 预览 / 下载
        │  postMessage(ArrayBuffer)
        ▼
worker.js（module worker）
  fetch 级联 → 初始化 wasm → 处理照片
        │  C ABI（直接调用导出函数）
        ▼
photo.js + photo.wasm
  cpp/photo_tool.cpp + cpp/photo_logic.cpp
        │
        ▼
OpenCV 4.10 wasm 静态库
  objdetect / imgcodecs / imgproc / calib3d / features2d / flann / core
```

Haar 检测在 12MP 照片上可能耗时约 1 秒，放在 worker 中执行以保证 UI 不冻结。单
worker、单线程，不使用 `SharedArrayBuffer`，因此部署时不需要 COOP/COEP 响应头。
级联文件（约 861 KB）随站点发布，worker 用 `fetch` 读取后写入 Emscripten MEMFS 再
加载，以走 OpenCV 的旧格式级联转换路径。

## 本地构建

依赖：GNU make、CMake、Ninja、git、curl、Python 3（Emscripten 工具链使用），以及一个
能编译 C++17 的 host 编译器（仅用于单元测试）。Emscripten 与 OpenCV 源码由 make
目标下载，无需系统预装。

```bash
make bootstrap    # emsdk 6.0.13 + OpenCV 4.10.0 源码（幂等）
make opencv       # wasm 静态库 → build/opencv-install
make wasm         # web/pkg/photo.js + photo.wasm
```

或一次完成全部三步：

```bash
make build
```

首次构建需要下载并编译 OpenCV，通常数分钟；之后执行 `make wasm` 仍会做一次增量
OpenCV 检查/安装，无变化时主要耗时在重新链接。`make build` 每次都会做一次增量
OpenCV 配置/构建/安装（无变化时通常几秒）；存在 `.opencv-config` stamp 且
`OPENCV_SRC`、`EMSDK_DIR`、CMake flags 或版本变化时，会清空 `build/opencv*` 从头重建。
产物为 `web/pkg/photo.js` 与约 1.4 MB 的 `web/pkg/photo.wasm`。

路径与端口可用变量覆盖（命令行或环境变量；相对路径按当前工作目录解析，因此
`make -C <repo>` 也可用）：

```bash
make build \
  EMSDK_DIR=/opt/emsdk \
  OPENCV_SRC=/opt/opencv-4.10.0 \
  OPENCV_BUILD=/tmp/opencv-build \
  OPENCV_INSTALL=/tmp/opencv-install \
  JPEG_LIB=/tmp/opencv-build/3rdparty/lib/liblibjpeg-turbo.a
```

可覆盖的变量：`EMSDK_DIR`、`OPENCV_SRC`、`OPENCV_BUILD`、`OPENCV_INSTALL`、
`JPEG_LIB`、`PORT`、`SERVE_ROOT`。不设置时全部落在仓库内（`PORT` 默认 8000，
`SERVE_ROOT` 默认 `.`，即以仓库根目录为站点根）。构建路径不要包含空格：库文件列表
按空白分词传给编译器，含空格的目录名会导致链接失败。

`make` 在删除 `EMSDK_DIR`、`OPENCV_BUILD`、`OPENCV_INSTALL` 前会检查路径和目录内容
（拒绝空路径、`/`、仓库根目录及其祖先，并要求目录为空或具有 emsdk/OpenCV 特征）。
指向其他非空目录时会报错并停止；确认无误后请手工删除该目录再重试。

## 本地预览

```bash
make serve
# http://127.0.0.1:8000/web/
```

`make serve` 调用保留的 `scripts/serve.py`，为 `.wasm` 发送 `application/wasm`。
默认以仓库根目录为站点根（`SERVE_ROOT=.`），页面在 `/web/`、fixture 在
`/tests/fixtures/`，浏览器测试可直接打开 `?test=1`：

```bash
make serve PORT=8000
# http://127.0.0.1:8000/web/?test=1
```

只预览 `web/` 时可覆盖根目录：

```bash
make serve SERVE_ROOT=web
# http://127.0.0.1:8000/
```

请通过 HTTP 访问；`file://` 直接打开会因 module worker/fetch 的 CORS 限制失败，
wasm MIME 也会影响流式实例化。

`make dev` 先执行 `make build`，再启动同一个服务器。

`test=1` 只启用测试辅助接口，不影响正常使用。

## 测试

```bash
make test
```

`make test` 依赖 `make logic-test` 与 `make wasm`，会依次编译并运行
`tests/logic_test.cpp`、执行 `node tests/messages_test.mjs` 与 `node tests/run_wasm.mjs`。
只跑纯 C++ 单测（不需要 OpenCV/wasm 工具链）时用 `make logic-test`。

`logic_test` 覆盖背景色卡、色相/彩度边界、裁切公式、round-half-even、边界钳制、
居中校验、最宽脸选择与尾标记字节。`run_wasm` 覆盖 8 张 fixture 的错误码、p2 的
295×413 输出与尾标记、DQT 与参考图比对、SSIM、EXIF 方向不生效、非 JPEG/过小/损坏/
空文件/无人脸/12MP 边界。

## 部署

`.github/workflows/deploy.yml` 在 `push` 到 `main` 或手动 `workflow_dispatch` 时：

1. 安装 CMake 与 Ninja，缓存 `.emsdk`、`vendor/opencv-4.10.0`、`build/opencv`、
   `build/opencv-install`（缓存 key 含 runner OS、`Makefile` hash 与 OpenCV/emsdk 版本）；
2. 执行 `make build` 构建 wasm（`bootstrap` 负责激活缓存的 emsdk）；
3. 执行 `make test` 运行 C++ 单测、文案测试与 wasm 集成测试（`make build` 与
   `make test` 会各链接一次 wasm，本机约 2–3 秒；保留该顺序是为了让两步能独立失败）；
4. 打包 `web/` 并通过 `actions/deploy-pages` 发布到 GitHub Pages。

仓库设置中把 Pages 的 Source 选为 **GitHub Actions** 即可，无需 `gh-pages` 分支。
页面内所有资源（除 Cloudflare Web Analytics 外）都使用相对路径，因此同时兼容用户
主页与项目子路径（`https://<user>.github.io/<repo>/`）。`web/.nojekyll` 避免以
Jekyll 方式处理产物。首次运行因编译 OpenCV 较慢，命中缓存后通常在几分钟内完成。

部署后建议确认 `.wasm` 的 MIME 类型：

```bash
curl -sI https://<user>.github.io/<repo>/pkg/photo.wasm | grep -i content-type
# 期望：content-type: application/wasm
```

或在浏览器 DevTools 的 Network 面板查看 `photo.wasm` 响应头。若不是
`application/wasm`，Emscripten loader 会拒绝流式实例化。

## 隐私

- 照片读取、解码、人脸检测、裁切、编码与下载全部在浏览器本地完成，**不上传照片**，
  也没有账号、后端或云存储。
- 页面加载会请求 Cloudflare Web Analytics 做无 Cookie 访问统计，涉及两个 host：
  `static.cloudflareinsights.com`（脚本）与 `cloudflareinsights.com`（`/cdn-cgi/rum`
  上报）。上报内容不含照片、文件名或图片数据。
- 如果不需要统计，可在浏览器或网络中拦截上述两个 host；照片处理功能不受影响。
- 照片处理流程本身不发起网络请求；页面加载/离开时 Cloudflare 仅发送不含照片、
  文件名或图片数据的访问统计。

## 已知限制

- **不换底、不抠图、不磨皮/美白/调色**，只校验已有背景并自动裁切。
- **不应用 EXIF 方向**（有意与原 exe 一致）。手机竖拍且带旋转标记的照片可能被当作
  横图处理并报错；请先在相册中导出为正向 JPG。
- **仅支持 JPEG 输入**，不接受 PNG/WebP；截断（缺少 EOI）的文件按错误 1 处理——
  这是相对原 exe 的安全偏差，原 exe 可能部分解码截断文件。
- 多人合影时只取**最宽**的人脸，不提供选择 UI。
- 裁切框完全由公式决定，不提供手动平移/缩放。
- 追加的 10 字节尾标记不是标准 JPEG 段，部分查看器可能忽略或提示异常；报名上传端
  可能校验它，因此不能去掉。
- OpenCV 4.10 的人脸检测与原 exe 使用的 OpenCV 1.0 可能存在微小差异，裁切允许约 3%
  偏差；JPEG 编码器版本不同，输出字节不保证与桌面版逐字节相同（已校验尺寸、DQT 与
  SSIM）。
- 不提供 PWA 离线缓存或单文件 HTML 版本；交付形态是静态目录。

## 素材来源

- `web/assets/haarcascade_frontalface_alt2.xml`：OpenCV 官方
  `haarcascade_frontalface_alt2.xml` 级联，与桌面版使用同一模型。
- `tests/fixtures/`：8 张回归照片与边界输入，期望错误码来自实机运行结果。
- `tests/reference/p2_blue_reference.jpg`：p2 的参考输出，用于校验 q40 量化表与 SSIM。
