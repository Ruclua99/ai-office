@echo off
chcp 65001 >nul
title AI Office - Van phong ao
cd /d "%~dp0"
where node >nul 2>nul || (echo Chua cai Node.js. Tai ban LTS tai https://nodejs.org roi chay lai. & pause & exit /b 1)
if not exist node_modules (echo Dang cai thu vien lan dau... & call npm install || (pause & exit /b 1))
start "" cmd /c "timeout /t 4 >nul & start http://localhost:4800"
call npm start
:lai
echo.
echo [%date% %time%] May chu van phong da dung. Tu mo lai sau 5 giay...
echo (Muon tat han: dong cua so nay. Xem loi trong data\server.log)
timeout /t 5 >nul
call npm start
goto lai
