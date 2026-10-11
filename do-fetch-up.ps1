Set-Location "C:\Users\14499\Desktop\tv\LibreTV"
git fetch https://gh-proxy.com/https://github.com/LibreSpark/LibreTV.git main:refs/remotes/upstream-check/main 2>&1 | Out-File "C:\Users\14499\Desktop\tv\fetch-up.txt"
"EXIT:$LASTEXITCODE" | Out-File "C:\Users\14499\Desktop\tv\fetch-up.txt" -Append
