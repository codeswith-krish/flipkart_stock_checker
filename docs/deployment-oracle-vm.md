# Oracle Cloud Always Free VM Deployment & Hardening Guide

## Overview
This document provides production deployment instructions, systemd service configuration, and resource calibration procedures for running the **Flipkart Stock Checker** on an Oracle Cloud Always Free Linux VM (`VM.Standard.E2.1.Micro`).

---

## 1. System Specifications & Tuning Philosophy

### Hardware Baseline
- **Shape**: `VM.Standard.E2.1.Micro`
- **OCPU**: 1 AMD EPYC Core
- **Physical Memory**: 1 GB RAM
- **Operating System**: Ubuntu 22.04 LTS or Oracle Linux 8/9

> [!IMPORTANT]
> In a 1GB physical memory budget, Chromium memory consumption, Node.js heap limits, check durations, and swap allocation cannot be estimated with theoretical guarantees. **All performance and resource limits documented below are tunable parameters that must be empirically measured and calibrated on the target host VM using the benchmarking protocol in Section 4.**

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

## 3. Chromium Low-Memory Configuration

The browser lifecycle manager (`src/modules/scraper/browser.ts`) already implements low-memory safeguards:
- `--disable-dev-shm-usage`: Directs Chromium shared memory buffers to `/tmp` rather than `/dev/shm` (which is constrained to 64MB by default).
- `--no-sandbox` & `--disable-setuid-sandbox`: Ensures unprivileged execution.
- `--disable-gpu`: Eliminates GPU rendering process overhead.
- **Media Aborting**: Every page context intercepts and aborts `image`, `media`, and `font` requests.

---

## 4. Empirical Benchmarking Protocol

Follow this 4-step protocol on the host machine to establish empirical baselines before starting production monitoring:

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

---

## 5. Production systemd Service Configuration

### Service File Installation
Create `/etc/systemd/system/stock-checker.service`:

```ini
[Unit]
Description=Flipkart Stock Checker Background Daemon
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/stock_checker
Environment=NODE_ENV=production
Environment=NODE_OPTIONS="--max-old-space-size=256"
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=15

# Resource ceilings (tune based on Step 2 benchmark results)
MemoryHigh=600M
MemoryMax=750M

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=stock-checker

[Install]
WantedBy=multi-user.target
```

### Service Commands:
```bash
# Reload systemd daemon
sudo systemctl daemon-reload

# Enable service to start on boot
sudo systemctl enable stock-checker

# Start service
sudo systemctl start stock-checker

# Check service status & resource usage
sudo systemctl status stock-checker

# View real-time daemon logs
sudo journalctl -u stock-checker -f
```

---

## 6. Authentication Setup (Interactive Bootstrap)

Before starting the daemon, perform the one-time interactive login:

```bash
# Launch headful browser window to log in via mobile / OTP
npm run auth:login
```

- Complete OTP login in the browser.
- Press **ENTER** in the terminal to save the session.
- Script validates authentication and saves `storageState` to `./data/auth/flipkart_session.json` with `-rw-------` (`0600`) permissions.
