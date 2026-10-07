$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$Requirements = Join-Path $ProjectRoot "requirements-chroma.txt"
$DataPath = Join-Path $ProjectRoot "chroma_data"
$EnvironmentPath = Join-Path $ProjectRoot ".chroma-venv"
$PythonPath = Join-Path $EnvironmentPath "Scripts\python.exe"
$ChromaExecutable = Join-Path $EnvironmentPath "Scripts\chroma.exe"

if (-not (Test-Path $PythonPath)) {
  Write-Host "Creating an isolated Python environment for ChromaDB..."
  python -m venv $EnvironmentPath
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

if (-not (Test-Path $ChromaExecutable)) {
  Write-Host "Installing the ChromaDB service dependency..."
  & $PythonPath -m pip install -r $Requirements
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

if (-not (Test-Path $ChromaExecutable)) {
  Write-Error "ChromaDB CLI was not found after installation. Check the Python pip scripts directory."
  exit 1
}

Write-Host "Starting ChromaDB at http://127.0.0.1:8000; persistent data: $DataPath"
& $ChromaExecutable run --path $DataPath --host 127.0.0.1 --port 8000