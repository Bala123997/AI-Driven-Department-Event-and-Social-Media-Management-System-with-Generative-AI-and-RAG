@echo off
REM KARE CSE Social Platform - Auto Startup
REM This batch file starts the entire application with one click

cls
echo.
echo ========================================
echo  KARE CSE Social Platform
echo  Starting API + Dev Server...
echo ========================================
echo.

REM Change to project directory
cd /d "C:\Users\mahes\Downloads\CSP Project-main\Social media platform for departments"

REM Check if MySQL is running
echo Checking MySQL service...
powershell -Command "Start-Service 'MySQL80' -ErrorAction SilentlyContinue"

REM Start the application
npm run start

REM Keep window open if there's an error
pause
