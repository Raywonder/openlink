# Project Setup Guidelines - ALWAYS FOLLOW THESE RULES

This document contains AUTHORITATIVE guidelines that must be followed for ALL project setups and deployments. AI agents and developers MUST read and follow these rules for every project.

## 0. MANDATORY READING REQUIREMENT

Before creating ANY project, you MUST:
1. Read global-Infrastructure.md completely (located in root of this folder and update on all remote servers like /home/devinecr/*
across all paths that use the file and all other files listed within the systemrules.md file.)
2. Apply these rules without exception
3. Update this document when adding new patterns
4. Never deviate from these guidelines

This file defines REALITY for project setup.

---

## 1. INFRASTRUCTURE RULES (AUTHORITATIVE)

### Process Management
- PM2 is the ONLY supported process manager for Node.js applications
- systemd is FORBIDDEN for Node.js apps
- Web servers must NEVER manage Node processes
- PM2 must run under dedicated service user

### Filesystem Organization
- Source code in /home/devinecr/apps/project-name/source/
- Build artifacts in /home/devinecr/apps/project-name/build-temp/
- Release packages in /home/devinecr/apps/project-name/releases/
- Frontend files in /home/devinecr/public_html/project-name/

### Permissions (CRITICAL)
- All projects owned by devinecr:devinecr
- Directories: 755
- Files: 644
- Executable scripts: 755
- NEVER use root for application processes

---

## 2. WEB SERVER CONFIGURATION (MANDATORY)

### Nginx Proxy Setup
- Frontend files: /home/devinecr/public_html/project-name/client
- API proxy to localhost port
- Socket.IO proxy for real-time communication
- SSL with Let's Encrypt certificates

---

## 3. PM2 CONFIGURATION (MANDATORY)

### Basic Commands
- Start: pm2 start source/server/main.js --name project-api
- Stop: pm2 stop project-api
- Restart: pm2 restart project-api
- Status: pm2 status
- Logs: pm2 logs project-api --lines 50

### Process Management
- Name must include project identifier
- Use fork mode unless clustering required
- Save PM2 configuration: pm2 save
- Setup startup script: pm2 startup

---

## 4. PROJECT CHECKLIST (REQUIRED)

### Pre-Setup Checklist
- [ ] Read Infrastructure.md completely
- [ ] Identify project requirements
- [ ] Create directory structure following rules
- [ ] Set proper ownership and permissions
- [ ] Plan network ports and SSL

### Post-Setup Checklist  
- [ ] PM2 process running correctly
- [ ] Nginx proxy configured and tested
- [ ] SSL certificate installed and valid
- [ ] API endpoints responding
- [ ] Frontend accessible via domain
- [ ] Create status report file

---

## 5. MONITORING AND MAINTENANCE

### Daily Checks
- PM2 process status
- Disk space usage
- SSL certificate expiry
- Nginx error logs

### Weekly Tasks
- Update dependencies if needed
- Review PM2 logs for issues
- Check backup integrity

---

## 6. TROUBLESHOOTING GUIDE

### Common Issues and Solutions

#### PM2 Process Issues
Check status: pm2 status
Restart if failed: pm2 restart project-api
Check logs: pm2 logs project-api

#### Nginx Proxy Issues
Test configuration: nginx -t
Reload if OK: systemctl reload nginx
Test proxy: curl -s https://project.devinecreations.net/api/status

#### Permission Issues
Fix ownership: chown -R devinecr:devinecr /home/devinecr/apps/project-name/
Fix permissions: chmod -R 755 /home/devinecr/apps/project-name/

---

## 7. DOCUMENTATION STANDARDS

### Required Files
- Infrastructure.md (this file)
- README.md in each project root
- STATUS_REPORT.txt in project directory

### Status Report Template
Project Status Report
==================
Date: [DATE]
Server: [SERVER]
User: devinecr

=== DIRECTORY STRUCTURE ===
[Details following standard template]

=== PM2 PROCESS MANAGEMENT ===
[Commands and status]

=== NGINX PROXY CONFIGURATION ===
[Domain and proxy details]

=== API STATUS ===
[Server version and capabilities]

=== COMPLIANCE ===
[Infrastructure.md adherence]

=== NEXT STEPS ===
[Planned improvements]

---

## FINAL STATEMENT

This document governs ALL project setups. It applies to:
- New projects
- Existing projects  
- AI agent work
- Manual human work
- Emergency fixes

This file defines reality for project setup.

ALWAYS READ Infrastructure.md BEFORE STARTING ANY PROJECT!
Last Updated: Mon Jan 19 23:13:09 EST 2026

## 11. FIREWALL CONFIGURATION (MANDATORY)

### UFW Rules (Recommended)
All VoiceLink applications must have these firewall rules:


### Port Compatibility Check
- NEVER use ports 2082-2087, 2095, 2077 (cPanel reserved)
- ALWAYS check for conflicts before assigning ports
- Use standard port ranges: 3000-5000 for applications
- Document all port assignments in status reports

### CSF/LFD Prohibition
- CSF (ConfigServer Firewall) is FORBIDDEN
- LFD (Login Failure Daemon) is FORBIDDEN  
- Use UFW or iptables directly instead
- Remove any CSF/LFD packages if found

## 12. CROSS-PLATFORM BUILDING (MANDATORY)

### Build Environment Requirements
- Use proper build directories with absolute paths
- Ensure assets/sounds directories exist before building
- Test on native platforms when possible
- Document Wine limitations for Linux builds

### Native App Requirements
- Windows builds require Windows environment or Wine
- macOS builds require macOS environment
- Linux builds can test without emulation
- Code signing requires platform-specific certificates

### Sound/Audio Integration
- All apps must include working audio feedback
- Menu sounds, connection alerts, notifications
- Test audio on all target platforms
- Include accessibility features per Infrastructure.md

## 13. DOCUMENTATION UPDATES (REQUIRED)

### When Changes Are Made
1. Update Infrastructure.md with new patterns
2. Update PROJECT_SETUP_GUIDELINES.md with learnings  
3. Update project status reports with fixes
4. Document all limitations and workarounds
5. Create troubleshooting guides for common issues

### Version Control
- Commit all configuration changes
- Tag releases with version numbers
- Document breaking changes prominently
- Maintain CHANGELOG.md in each project

