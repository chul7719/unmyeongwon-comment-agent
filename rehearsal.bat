@echo off
chcp 65001 >nul
cd /d %~dp0
if not exist node_modules call npm install
if not exist .env copy .env.example .env >nul
echo [리허설 모드] 타이핑까지만 하고 실제로 게시하지 않습니다.
node server.js --rehearsal
pause
