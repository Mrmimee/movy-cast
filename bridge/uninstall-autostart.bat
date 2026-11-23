@echo off
chcp 65001 >nul
set "HOST_NAME=com.movy.cast"

reg delete "HKCU\Software\Google\Chrome\NativeMessagingHosts\%HOST_NAME%" /f >nul 2>&1
reg delete "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\%HOST_NAME%" /f >nul 2>&1
del /f /q "%~dp0com.movy.cast.json" >nul 2>&1

echo.
echo [完成] 已取消 Movy Cast 自动启动注册。
echo.
pause
