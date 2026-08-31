function escapeHtml(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

export function loadErrorHtml(title: string, detail: string): string {
  return `
<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<title>字体管理器 启动错误</title>
<style>
  body {
    margin: 0;
    background: #101114;
    color: #f2f4f8;
    font-family: "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif;
  }
  .box {
    max-width: 860px;
    margin: 80px auto;
    background: #17191f;
    border: 1px solid #2a2f3c;
    border-radius: 18px;
    padding: 28px;
  }
  h1 { margin: 0 0 12px; font-size: 24px; }
  p { color: #aab2c0; line-height: 1.7; }
  pre {
    white-space: pre-wrap;
    word-break: break-word;
    background: #0e1015;
    border: 1px solid #2a2f3c;
    border-radius: 12px;
    padding: 14px;
    color: #d7def0;
  }
</style>
</head>
<body>
<div class="box">
  <h1>${escapeHtml(title)}</h1>
  <p>渲染界面没有成功加载。请把下面的错误内容发回来。</p>
  <pre>${escapeHtml(detail)}</pre>
</div>
</body>
</html>`
}
