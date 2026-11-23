@echo off
chcp 65001 >nul
cd /d "%~dp0"

set "HOST_NAME=com.movy.cast"
set "EXT_ID=jjhjcmleakcadeijeoapkiabnhfjdinm"
set "MANIFEST_PATH=%~dp0com.movy.cast.json"

node -e "const fs=require('fs'),p=require('path');const dir=process.cwd();const m={name:'com.movy.cast',description:'Movy Cast DLNA Bridge',path:p.join(dir,'native-host.bat'),type:'stdio',allowed_origins:['chrome-extension://jjhjcmleakcadeijeoapkiabnhfjdinm/']};fs.writeFileSync(p.join(dir,'com.movy.cast.json'),JSON.stringify(m,null,2),'utf8');"

if errorlevel 1 (
  echo [错误] 未检测到 Node.js，请先安装 Node.js。
  pause
  exit /b 1
)

reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\%HOST_NAME%" /ve /t REG_SZ /d "%MANIFEST_PATH%" /f >nul 2>&1
reg add "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\%HOST_NAME%" /ve /t REG_SZ /d "%MANIFEST_PATH%" /f >nul 2>&1

echo.
echo [完成] Movy Cast 自动启动已注册（支持 Chrome 与 Edge）！
echo 以后打开 movy.sx 即可自动唤起投屏服务，无需再手动双击任何脚本。
echo.
pause
