# HanFontManager DirectWrite Preview Renderer

This folder contains the Windows helper protocol for the next-generation preview renderer.

Runtime behavior:

1. The Electron main process looks for `hfm-preview-renderer.exe` in `build/native` during development or `resources/native` after packaging.
2. If the helper exists, native preview generation is attempted through this helper first.
3. If the helper is missing or fails, the app falls back to the existing PowerShell/GDI renderer, so current previews remain usable.

Build on Windows with MSVC Developer Command Prompt:

```bat
build-win.cmd
```

Expected command protocol:

```bat
hfm-preview-renderer.exe --input C:\path\to\request.json
```

The request JSON is written by the main process and includes:

```json
{
  "fontPath": "O:\\Fonts\\demo.ttf",
  "text": "字体预览 AaBb 123",
  "fontSize": 72,
  "width": 900,
  "height": 260,
  "outputPath": "C:\\preview-cache\\abc.png"
}
```

The helper should write a PNG to `outputPath` and print a small JSON result to stdout.
