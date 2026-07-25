@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo   INDIVA Trendyol Scraper - Kurulum
echo ============================================
echo.

REM 1) Node.js var mi?
where node >nul 2>nul
if errorlevel 1 (
  echo [HATA] Node.js kurulu degil.
  echo        https://nodejs.org adresinden LTS surumunu kurun, sonra bu dosyayi tekrar calistirin.
  echo.
  pause
  exit /b 1
)

REM 2) service-account.json var mi?
if not exist "service-account.json" (
  echo [HATA] service-account.json bulunamadi.
  echo        Firebase servis hesabi dosyasini bu klasore "service-account.json" adiyla kopyalayin.
  echo.
  pause
  exit /b 1
)

REM 3) Chrome var mi? (uyari, engellemez)
if not exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" if not exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" (
  echo [UYARI] Google Chrome bulunamadi. Scraping icin Chrome gerekli.
  echo         https://www.google.com/chrome adresinden kurun.
  echo.
)

echo [1/3] Bagimliliklar kuruluyor (npm install)... biraz surebilir.
call npm install
if errorlevel 1 (
  echo [HATA] npm install basarisiz.
  pause
  exit /b 1
)

echo.
echo [2/3] Otomatik baslatma ayarlaniyor...
powershell -ExecutionPolicy Bypass -File "%~dp0install-autostart.ps1"

echo.
echo [3/3] Dinleyici baslatiliyor...
start "" /min "%~dp0start-listener.cmd"

echo.
echo ============================================
echo   TAMAMLANDI
echo   Dinleyici calisiyor ve PC her acildiginda
echo   otomatik baslayacak. Artik telefondan
echo   "Veri Cek" ile tetikleyebilirsiniz.
echo ============================================
echo.
pause
