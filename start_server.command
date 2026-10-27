#!/bin/bash
cd "$(dirname "$0")"
PORT=8765
echo "ネットワークスペシャリスト CBTシミュレータを起動しています (http://localhost:${PORT}/index.html) ..."
(sleep 1 && open "http://localhost:${PORT}/index.html") &
python3 -m http.server ${PORT}
