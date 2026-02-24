# Distributed AI Control & Execution Specification

**Purpose:**
This document defines the canonical instructions, architecture, and execution rules for OpenCode (local fork) to act as a *Claude Code–class replacement*, operating fully locally and across a distributed environment.

This spec MUST be followed by OpenCode when managing, provisioning, executing, or coordinating tasks across servers, Macs, Windows (WSL), and future nodes.

---

## 1. CORE PRINCIPLES (NON‑NEGOTIABLE)

1. **Server‑First Control Plane**
   - The primary control plane lives on the main Linux server.
   - All logic, routing, orchestration, and APIs originate from the server.
   - Clients (Mac / Windows / WSL) are execution nodes, not authorities.

2. **Local‑First, API‑Unified**
   - Prefer local execution over cloud APIs.
   - When APIs are used, route them through existing server APIs.
   - No hard dependency on third‑party SaaS for core functionality.

3. **No Artificial Execution Limits**
   - OpenCode is authorized to:
     - Run commands
     - Modify files
     - Install packages
     - Manage services
   - Execution safety is achieved via *role separation*, not refusal.

4. **Headscale / Tailscale as Network Fabric**
   - All inter‑node communication occurs over Headscale.
   - No assumptions about public IP reachability.

---

## 2. EXISTING INFRASTRUCTURE (AUTHORITATIVE)

OpenCode MUST detect, reuse, or hook into existing systems before creating new ones.

### Server APIs (Already Exist)
- `/home/devinecr/apps/hubnode/*`
  - Process monitoring
  - App health
  - Notification dispatch

- `/home/devinecr/apps/ecripto-api`
- `/home/ecriptoapp/*/*`
- https://ecripto.app

These APIs are **canonical** and should be extended, not replaced.

---

## 3. NODE TYPES

### A. Server Node (Primary)
- Linux
- AMD Ryzen
- 128GB RAM
- CPU‑only inference
- Hosts:
  - Ollama
  - Open WebUI (optional frontend)
  - OpenCode control services

### B. Mac Nodes
- MacBook Pro 2017 (16GB RAM)
- Mac Mini 2018
- Future iMac 2020–2022

Capabilities:
- Swift / Xcode builds
- macOS‑specific signing
- UI builds
- Backup inference nodes

### C. Windows Nodes
- Windows + WSL
- Linux workloads via WSL
- Development + testing

---

## 4. NODE AGENT REQUIREMENTS

Each node MUST run a lightweight agent that:

- Registers node metadata
- Sends heartbeat
- Reports capabilities
- Accepts execution tasks
- Returns logs + results

### Required Heartbeat Payload
```json
{
  "node_id": "unique-name",
  "type": "server|mac|windows|wsl",
  "ram_gb": 16,
  "cpu": "string",
  "gpu": false,
  "ollama": true,
  "models": ["qwen3:8b", "devstral"],
  "exec_modes": ["full_exec"],
  "status": "online"
}
```

---

## 5. TASK ROUTING LOGIC

OpenCode MUST dynamically choose execution location.

### Decision Inputs
- Model availability
- RAM
- CPU load
- Node type
- User preference

### Example Routing Rules
- Swift / macOS builds → Mac nodes
- Heavy inference → Server
- Linux scripting → Server or WSL
- UI testing → Local node

OpenCode MAY:
- Auto‑select node
- Ask user
- Fail over to another node

---

## 6. EXECUTION AUTHORIZATION MODEL

Nodes declare allowed execution modes:

- `read_only`
- `confirm`
- `full_exec`

OpenCode MUST NOT refuse tasks that are within declared permissions.

---

## 7. MODEL MANAGEMENT

### Ollama Rules
- Models may exist on multiple nodes.
- Models can be stored on external drives.
- Symbolic links are valid.

OpenCode SHOULD:
- Detect available models per node
- Prefer local models
- Fall back to remote nodes

---

## 8. OPEN WEBUI ROLE

Open WebUI is:
- A frontend
- Not a decision authority

OpenCode is responsible for:
- Task routing
- Execution
- Status reporting

---

## 9. NOTIFICATIONS

Use existing notification APIs to report:
- Node online/offline
- Task start / completion
- Failover events
- Errors

---

## 10. SECURITY & NETWORKING

- Prefer Headscale IPs
- No direct LAN assumptions
- No hard‑coded IPs

Optional:
- Reverse proxy exposure via:
  - `ollama*.tappedin.fm`
  - `ollama*.raywonderis.me`

---

## 11. FUTURE EXTENSIONS (ALLOWED)

- Accessibility enhancements
- Voice / TTS
- NVDA integration
- UI labeling fixes
- Multi‑user roles

These MUST NOT block core functionality.

---

## 12. FINAL AUTHORITY

If ambiguity exists:
1. Prefer existing infrastructure
2. Prefer server‑side logic
3. Prefer execution over refusal
4. Ask only if ambiguity blocks execution

**This document is the single source of truth for OpenCode behavior.**

