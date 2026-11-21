@echo off
chcp 65001 >nul
title ระบบจัดการคิวรถขนส่งสินค้า (Truck Queue System)

echo ========================================================
echo    🚚 ระบบจัดการคิวรถขนส่งสินค้า (Truck Queue System)
echo ========================================================
echo กำลังเริ่มต้นระบบ...
echo.

cd /d "%~dp0"
start "" "http://localhost:3000/staff"
start "" "http://localhost:3000/tv"

node server.js
pause
