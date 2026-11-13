#!/data/data/com.termux/files/usr/bin/bash
set -e

echo "========================================================"
echo "  Locat Monitor - Android Phone Local Engine (Termux)"
echo "========================================================"

if command -v termux-wake-lock >/dev/null 2>&1; then
  termux-wake-lock || true
fi

if ! command -v node >/dev/null 2>&1; then
  echo "[*] Installing Node.js LTS inside Termux..."
  pkg update -y && pkg install -y nodejs-lts git
fi

if [ ! -d "node_modules" ]; then
  echo "[*] Installing packages (first run only)..."
  npm install
fi

echo "[*] Building production server..."
npm run build

echo ""
echo "✅ Engine ready! Open Locat Monitor APK or browser at:"
echo "   http://127.0.0.1:3000"
echo ""

export PORT=3000
npm start
