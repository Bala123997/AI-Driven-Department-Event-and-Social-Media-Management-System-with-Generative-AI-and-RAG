# KARE CSE Social Platform - PowerShell Startup Script
# Run this to start the application: .\START_APP.ps1

Write-Host ""
Write-Host "╔════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║  KARE CSE Social Platform                 ║" -ForegroundColor Cyan
Write-Host "║  Starting API + Dev Server...             ║" -ForegroundColor Cyan
Write-Host "╚════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# Set project directory
$projectDir = "C:\Users\mahes\Downloads\CSP Project-main\Social media platform for departments"

# Change to project directory
Set-Location $projectDir

# Check MySQL service
Write-Host "🔧 Checking MySQL service..." -ForegroundColor Yellow
$mysqlStatus = Get-Service "MySQL80" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Status

if ($mysqlStatus -eq "Running") {
    Write-Host "✅ MySQL is running" -ForegroundColor Green
} else {
    Write-Host "⚠️  Starting MySQL service..." -ForegroundColor Yellow
    try {
        Start-Service "MySQL80" -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
        Write-Host "✅ MySQL started" -ForegroundColor Green
    } catch {
        Write-Host "❌ Failed to start MySQL" -ForegroundColor Red
    }
}

Write-Host ""
Write-Host "🚀 Starting application..." -ForegroundColor Green
Write-Host "   API: http://localhost:3001" -ForegroundColor Cyan
Write-Host "   Web: http://localhost:8080" -ForegroundColor Cyan
Write-Host ""

# Start the application
npm run start

# If npm run start fails
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "❌ Failed to start application" -ForegroundColor Red
    Write-Host "Press any key to close..." -ForegroundColor Yellow
    $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
}
