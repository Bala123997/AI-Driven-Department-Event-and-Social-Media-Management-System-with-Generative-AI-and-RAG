export function renderErrorPage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Server Error</title>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: system-ui, sans-serif; color: #14213d; background: #f4f6fb; }
      main { max-width: 34rem; padding: 2rem; text-align: center; background: #fff; border: 1px solid #e2e8f2; }
      h1 { margin-top: 0; }
      p { color: #6b7a90; line-height: 1.6; }
    </style>
  </head>
  <body><main><h1>Something went wrong</h1><p>The server could not render this page. Check the development terminal for the original error.</p></main></body>
</html>`;
}
