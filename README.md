# Movy Cast

极简、干净的浏览器电视投屏（DLNA）与中文字幕助手，支持 **movy.sx** 与 **cinejoy.pk**。

## 核心特性
- **原生融入右下角控制栏**：自动贴合全屏按钮左侧，尺寸、亮度与线宽对齐原生图标；弹窗与影院字幕均采用 Shadow DOM 样式隔离，点击外部 / `Esc` 自动关闭。
- **国产电视 DLNA 投屏 & 遥控**：零依赖纯 Node.js 本地桥接，自动发现局域网电视，支持 Referer 防盗链代理、HLS `.m3u8` 重写、进度拖动、暂停/继续、音量调节与换集续投。
- **随网站自动启停**：基于 Chrome / Edge Native Messaging，打开支持的影视页自动拉起，关掉标签页后空闲自动退出，平时零常驻进程。
- **精校中文字幕 + 去广告清洗**：内置迅雷云端精校中文字幕源（简体优先，支持 `.ass`/`.srt`/`.vtt` 与 UTF-8/GBK 防乱码，自动过滤广告水印行），独立开关可控，网页端与电视投屏同步生效。
- **音画 / 字幕同步校准**：支持原字幕时间轴比对 / 听声对齐一键校准，以及 `±0.1s` / `±0.5s` 精调并按片记忆。

## 一次性安装（2 步，以后全自动）

### 1. 注册按需自动启动（仅需运行一次）
- 双击运行 `bridge/install-autostart.bat`（支持 Chrome / Edge，无需管理员权限，依赖本机 Node.js）。
- 首次唤起如弹出 Windows 防火墙提示，请允许「专用网络」访问，并确保电脑与电视在同一 Wi-Fi 下。
- 卸载自动启动：双击 `bridge/uninstall-autostart.bat`。

### 2. 加载浏览器插件
1. 打开 `chrome://extensions`（Edge 为 `edge://extensions`）
2. 开启右上角「开发者模式」
3. 点击「加载已解压的扩展程序」，选择本项目的 `extension` 文件夹

## 扩展适配其他同类网站
本项目采用通用流捕获与 Shadow DOM 播放器 UI，新增同类网站只需修改 3 处：
1. `extension/manifest.json`：在 `host_permissions` 和 `content_scripts[0].matches` 添加目标域名；
2. `extension/background.js`：在 `isMovyUrl()` 正则中加入目标域名；
3. `extension/content.js`：在 `cleanMovieTitle()` 中添加该站点标题后缀过滤即可。
