# Infrastructure, Runtime, Federation, Containerization, and Governance Rules (AUTHORITATIVE)

This document defines **non-negotiable rules** for how applications, services,
AI agents, containers, and infrastructure are built, deployed, migrated, updated,
audited, and operated across all environments.

It applies regardless of:
- operating system
- server provider
- virtualization or container layer
- user account
- filesystem layout
- AI tooling presence

This document is authoritative for:
- local development machines
- desktops (Windows, macOS)
- servers (bare metal or virtual)
- containers
- federation nodes (including Mastodon)
- contractor or client-managed systems
- autonomous AI agents
Instructions from systemrules.md should always be applyed as well with rules in this document.
**This file defines reality.**

---

## 0. Tooling and AI neutrality (IMPORTANT)

No specific AI tool is required.

- Some environments may have Claude
- Some may have LLaMA, Ollama, llama.cpp, Agent Zero–style agents
- Some may have no AI tooling at all

These rules apply regardless.

If AI agents are used:
- They must read and follow this document
- They do not override this document
- Their output must comply with it

This is infrastructure governance, not AI configuration.

---

## 1. Electron is deprecated

Electron is legacy and transitional.

Rules:
- Do NOT introduce Electron by default
- Do NOT assume Electron APIs
- Do NOT embed Node runtimes

Exception (X + Y rule):
- A documented technical requirement exists
- A written migration plan to native clients exists

Electron apps are clients only and contain no server logic.

---

## 2. Updates, migrations, and continuity (CRITICAL)

Updates must be seamless and non-destructive.

End users must never be required to:
- reconfigure settings
- move files
- understand backend changes

Breaking changes require versioning, transition periods, and documentation.

---

## 3. Process management (Node)

- PM2 is the ONLY supported process manager for Node
- systemd for Node apps is forbidden
- Web servers must never manage Node processes

PM2 must run as a dedicated service user.

---

## 4. Restart and admin operations

- Restart logic must live inside applications
- Admin endpoints must be authenticated
- No sudo or shell execution from web servers

---

## 5. Web server role (Apache / Nginx)

Web servers MAY:
- Reverse proxy
- Serve static assets and client apps
- Serve documentation and downloads

Web servers MUST NOT:
- Execute Node
- Own application logic
- Store secrets

---

## 6. Filesystem organization (BALANCED)

Single logical application trees only.

Web-accessible directories MAY be used for:
- Client front ends
- Static assets
- Documentation (HTML/TXT)
- Media embeds and installers

They must not contain secrets or server logic.

---

## 7. Federation and Mastodon awareness

Federation must be API-driven and versioned.

### Mastodon
When a Mastodon instance is detected:
- Identify instance root and environment
- Never modify core files directly
- Prefer themes, overrides, and embeds

Example:
AzuraCast players must be embedded client-side only,
never altering federation behavior or storing credentials.

---

## 8. Service coexistence

Independent services must:
- Run separately
- Fail independently
- Never cascade failures

---

## 9. Permissions and identity (CRITICAL)

- Dedicated service users required
- Root only for OS maintenance
- Agents may repair ownership and permissions safely

---

## 10. Accessibility-first development (MANDATORY)

- AccessKit is required for UI-capable clients
- Accessibility regressions block releases

---

## 11. Documentation governance

Documentation formats:
- Markdown
- HTML
- TXT

Agents must audit and align all documentation with this file.

---

## 12. Local and networked AI runtime management

AI runtimes are OPTIONAL accelerators.

Agents must detect:
- OS, CPU, RAM
- GPU / Metal / CUDA / ROCm
- Network peers (Headscale-aware)

Shared models are preferred when safe.

---

## 13. Directory creation, cleanup, and hygiene

Agents may:
- Create required directories
- Clean unused empty directories
- Normalize layouts

Agents must never delete user data or active configs.

---

## 14. WHMCS, cPanel, and hosted platforms

Agents must respect vendor-managed files.

Agents may:
- Audit APIs and modules
- Document configurations
- Align custom integrations

---

## 15. Autonomous agent authority

Agents may act autonomously.

User approval is required only for:
- Data loss risk
- Security posture changes
- Federation contract changes

---

## 16. Containerization (Docker / Podman)

Containers are supported but governed.

Rules:
- Declarative configs only
- Explicit volumes
- No privileged containers without justification

---

## 17. Virtual machines (VMs)

VMs may use host-mounted volumes:
- Read-only preferred
- Read-write only when required

Disk constraints must be detected and respected.

---

## 18. AI agents in VMs and containers

Agent Zero–style agents must:
- Respect resource limits
- Be auditable and stoppable
- Follow this document

---

## 19. Volumes and permissions

- Explicit mounts only
- Correct ownership required
- Agents may repair permissions

---

## 20. Cockpit detection

On Linux VMs:
- Detect Cockpit
- Verify service health
- Document access URL

Installation requires approval unless instructed.

---

## 21. Web-based AI UIs

AI web UIs:
- Must be authenticated
- Must not require root
- Must respect reverse proxy rules
If Open Web UI is not installed, should be for running ollama and other related apps with proper reverse proxeying. Recommend instilation before installing. Skip if not aproved.
---

## 22. Docker and Mastodon coexistence

Containers must not interfere with federation.

Mastodon remains authoritative.

---

## 23. Network awareness

Agents must detect:
- Headscale
- Trusted IP ranges (64.20.46.178–82)
- Peer machines

Reuse AI services where safe.

---

---

## APPENDIX A: Permanent Server Configuration

### Primary Servers

| Server | IP Range | SSH Port | Primary User |
|--------|----------|----------|--------------|
| Main Server | 64.20.46.178-82 | 450 | devinecr |
| VPS | 208.73.204.162 | 22 | devinecr |

### SSH Authentication
- **Key**: raywonder
- **Location**: ~/.ssh/raywonder
- **Backup**: dev/ssh-keys-backup/

---

## APPENDIX B: DNS and Nameserver Configuration (PERMANENT)

### Authoritative Nameservers
| Nameserver | IP Address |
|------------|------------|
| ns1.raywonderis.me | 64.20.46.178 |
| ns2.raywonderis.me | 64.20.46.179 |
| ns3.raywonderis.me | 64.20.46.180 |
| ns4.raywonderis.me | 64.20.46.181 |

### Managed Domains
| Domain | Registrar | Contact Email |
|--------|-----------|---------------|
| devine-creations.com | eNom/WHMCS | admin@devine-creations.com |
| devinecreations.net | eNom/WHMCS | admin@devinecreations.net |
| raywonderis.me | eNom/WHMCS | admin@raywonderis.me |
| bemamediaplayer.app | eNom/WHMCS | admin@bemamediaplayer.app |
| ecripto.app | eNom/WHMCS | admin@ecripto.app |
| tappedin.fm | Namecheap | admin@tappedin.fm |

### DNS Zone Files
- **Location**: /var/named/domain.db
- **Reload Command**: `rndc reload`

---

## APPENDIX C: Service Configuration

### Jellyfin Media Servers
| Name | Port | Domain | Owner User |
|------|------|--------|------------|
| TappedIn | 9096 | media.tappedin.fm | tappedin |
| Dom | 9097 | media.raywonderis.me | dom |

### VoiceLink
- **Main Server**: /home/devinecr/apps/voicelink-local/
- **VPS Mirror**: /home/devinecr/apps/voicelink-local/
- **API Port**: 3010

### Media Paths (Federated)
```
/home/tappedin/apps/media
/home/dom/apps/media
/home/devinecr/apps/media
/home/tetoeehoward/apps/media
/home/wharper/apps/media
```

---

## APPENDIX D: WHMCS Tracking Accounts

| Domain | Client ID | Email | Billing |
|--------|-----------|-------|---------|
| ecripto.app | 7 | support@ecripto.app | $0.00 (Free) |
| bemamediaplayer.app | 8 | support@bemamediaplayer.app | $0.00 (Free) |

---

## APPENDIX E: Port Allocations

### Reserved (NEVER USE)
- 2082-2087, 2095, 2077 (cPanel)

### Application Ranges
- 3000-5000: Standard apps
- 9096-9100: Media servers

---

## Final statement

This document governs:
- Hosts
- Virtual machines
- Containers
- AI agents
- Humans

It applies everywhere it exists.

**This file defines reality.**
