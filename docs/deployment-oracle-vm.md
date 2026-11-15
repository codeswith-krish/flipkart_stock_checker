# Oracle Cloud Always Free VM Deployment & Hardening Guide

## Overview
This document provides production deployment instructions, systemd service configuration, headless session verification, automated database backups, and resource calibration procedures for running the **Flipkart Stock Checker** on an Oracle Cloud Always Free Linux VM (`VM.Standard.E2.1.Micro`).

---

## 1. System Specifications & Tuning Philosophy

### Hardware Baseline
- **Shape**: `VM.Standard.E2.1.Micro`
- **OCPU**: 1 AMD EPYC Core
- **Physical Memory**: 1 GB RAM
- **Operating System**: Ubuntu 22.04 LTS or Oracle Linux 8/9

> [!IMPORTANT]
> In a 1GB physical memory budget, Chromium memory consumption, Node.js heap limits, check durations, and swap allocation cannot be estimated with theoretical guarantees. **All performance and resource limits documented below are tunable parameters that must be empirically measured and calibrated on the target host VM using the benchmarking protocol in Section 7.**

---

## 2. Swap Memory Configuration (Mandatory)

Running a modern headless browser on a 1GB RAM instance without adequate swap will trigger the Linux Out-Of-Memory (OOM) Killer.

### Swap Setup Procedure:
```bash
# 1. Allocate a 2GB swapfile (tune size based on empirical measurements)
sudo fallocate -l 2G /swapfile

# 2. Secure file permissions so only root can read swap
sudo chmod 600 /swapfile

# 3. Format as Linux swap
sudo mkswap /swapfile

# 4. Activate swapfile
sudo swapon /swapfile

# 5. Persist swap in /etc/fstab across reboots
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# 6. Verify swap is active
free -m
swapon --show
```

### Virtual Memory Swappiness Tuning:
```bash
# Configure swappiness to 10-20 to prefer physical RAM while avoiding OOM
sudo sysctl vm.swappiness=20
echo 'vm.swappiness=20' | sudo tee -a /etc/sysctl.conf
```

---

## 3. Chromium & Environment Hardening

The browser lifecycle manager (`src/modules/scraper/browser.ts`) implements several low-memory and cloud container safeguards:
- `BROWSER_NO_SANDBOX=true`: Enables unprivileged execution in environments without user namespaces (`--no-sandbox`, `--disable-setuid-sandbox`).
- `--disable-dev-shm-usage`: Directs Chromium shared memory buffers to `/tmp` rather than `/dev/shm` (which is constrained to 64MB by default).
- `--disable-gpu`: Eliminates GPU rendering process overhead.
- **Media Aborting**: Every page context intercepts and aborts `image`, `media`, and `font` requests.
- **Deterministic Cleanup**: The browser process closes in a `finally` block immediately after checks finish, freeing RAM before Telegram notification delivery begins.

### Environment Configuration (`.env`):
Ensure `.env` in the project root is secured with strict permissions:
```bash
chmod 600 /home/ubuntu/stock_checker/.env
```
Key production variables:
```env
NODE_ENV=production
TELEGRAM_BOT_TOKEN=123456789:ABCdefGhIJKlmNoPQRstuVWXyz
TELEGRAM_CHAT_ID=-1001234567890
BROWSER_HEADLESS=true
BROWSER_NO_SANDBOX=true
DATABASE_PATH=./data/stock_checker.db
SESSION_STORAGE_PATH=./data/auth/flipkart_session.json
CHECK_INTERVAL_CRON="*/5 * * * *"
LOG_LEVEL=info
```

---

## 4. Headless Session Bootstrap & Remote Verification

Because the remote Oracle Cloud VM is accessed headlessly over SSH without an X11 display server, interactive OTP authentication must be performed on an operator machine and transferred securely.

### Step 1: Local Interactive Authentication
On your local desktop/laptop (with a graphical display):
```bash
# Launch headful browser window to log in via mobile / OTP
npm run auth:login
```
1. Complete OTP login in the browser.
2. Press **ENTER** in the terminal to save the session.
3. The session is saved to `./data/auth/flipkart_session.json` with `0600` permissions.

### Step 2: Transfer Session to VM via SCP
```bash
# Securely copy the authenticated storageState to the VM
scp data/auth/flipkart_session.json ubuntu@<VM_PUBLIC_IP>:/home/ubuntu/stock_checker/data/auth/flipkart_session.json
```

### Step 3: Restrict File Permissions on VM
On the remote VM:
```bash
mkdir -p /home/ubuntu/stock_checker/data/auth
chmod 700 /home/ubuntu/stock_checker/data/auth
chmod 600 /home/ubuntu/stock_checker/data/auth/flipkart_session.json
```

### Step 4: Headless Session Verification on VM
Run the non-interactive verification script on the VM:
```bash
npm run auth:verify
```
Expected output:
```text
=================================================
       Flipkart Headless Session Verification    
=================================================
Target Session Storage: /home/ubuntu/stock_checker/data/auth/flipkart_session.json
[INFO] Verifying session storage file at: /home/ubuntu/stock_checker/data/auth/flipkart_session.json
[INFO] Session verified successfully: Flipkart session is valid and authenticated.

🎉 Session verification successful! Authenticated cookies are active.
```

---

## 5. Production systemd Service Configuration

### Service File Installation
A pre-configured systemd unit file is provided at `deploy/stock-checker.service`.

1. Copy the service unit to `/etc/systemd/system/`:
   ```bash
   sudo cp deploy/stock-checker.service /etc/systemd/system/stock-checker.service
   sudo chown root:root /etc/systemd/system/stock-checker.service
   sudo chmod 644 /etc/systemd/system/stock-checker.service
   ```

2. Validate the service unit syntax:
   ```bash
   systemd-analyze verify /etc/systemd/system/stock-checker.service
   ```

3. Build the application:
   ```bash
   npm run build
   ```

4. Enable and start the daemon:
   ```bash
   # Reload systemd daemon
   sudo systemctl daemon-reload

   # Enable service to start automatically on system boot
   sudo systemctl enable stock-checker

   # Start service
   sudo systemctl start stock-checker
   ```

### Managing & Monitoring the Service:
```bash
# Check service status & active memory footprint
sudo systemctl status stock-checker

# View real-time daemon logs via journalctl
sudo journalctl -u stock-checker -f

# View logs since current boot with redacted token verification
sudo journalctl -u stock-checker -b --no-pager
```

### Graceful Shutdown Verification:
When stopping or restarting the service:
```bash
sudo systemctl stop stock-checker
```
systemd sends `SIGTERM`. The application executes:
1. Stops new cron jobs from firing.
2. Waits up to 10 seconds for active in-flight checks and Telegram dispatches to drain.
3. Closes Playwright browser instance and SQLite database cleanly.
4. Exits with code 0.

---

## 6. SQLite Reliability & Automated Daily Backups

### Database Reliability Settings
The SQLite client (`src/db/client.ts`) enforces:
- `PRAGMA journal_mode = WAL;` (Concurrent readers during writes)
- `PRAGMA busy_timeout = 5000;` (Waits up to 5s if locked)
- `PRAGMA foreign_keys = ON;` (Referential integrity)
- Directory permissions enforced at `0700`.

### Safe Online Backup Script
The backup script (`scripts/backup-db.sh`) uses SQLite's native online `.backup` API, ensuring zero lock contention and no risk of database corruption.

Features:
- Verifies at least 100MB of free disk space before proceeding.
- Creates backup with timestamp: `stock_checker_YYYYMMDD_HHMMSSZ.db`.
- Sets strict `0600` file permissions.
- Runs `PRAGMA integrity_check;` to verify backup validity.
- Automatically prunes backups older than 7 days.

### Testing Manual Backup:
```bash
./scripts/backup-db.sh
```

### Scheduling Daily Backup via Crontab:
Configure a daily cron job at 03:00 UTC:
```bash
crontab -e
```
Add the following line:
```cron
0 3 * * * /home/ubuntu/stock_checker/scripts/backup-db.sh >> /home/ubuntu/stock_checker/data/backups/backup.log 2>&1
```

---

## 7. Empirical Benchmarking Protocol

Follow this 4-step protocol on the target host VM to establish empirical baselines before continuous production monitoring:

### Step 1: Baseline Idle Measurement
Measure idle system RAM before running any Node.js processes:
```bash
free -m
vmstat 1 5
```
Record `free` and `available` physical RAM.

### Step 2: Peak Resident Set Size (RSS) Measurement
Run a single check with the GNU `time` utility to measure maximum memory consumption:
```bash
/usr/bin/time -v npm run cli -- check-now --id <PRODUCT_ID>
```
Look for:
- `Maximum resident set size (kbytes)`: This reveals the true peak memory consumption of the combined Node + Chromium process tree.

### Step 3: Swap Activity & Thrashing Verification
Open two terminal windows:
- **Terminal 1**: Monitor swap input/output in real time:
  ```bash
  vmstat 1
  ```
- **Terminal 2**: Execute a full check cycle:
  ```bash
  npm run cli -- check-now
  ```
Observe columns `si` (swap in) and `so` (swap out). Brief spikes during Chromium startup are normal; continuous high numbers indicate swap thrashing, meaning swap size or Node heap cap must be tuned.

### Step 4: Check Duration & Cycle Capacity
Measure total cycle duration in logs. Verify that:
$$T_{\text{cycle}} = (\text{Duration per Product} \times \text{Active Products}) < 240\text{ seconds}$$
This ensures the sequential check cycle comfortably finishes within the 5-minute (300-second) cron tick without overlapping.
