# IMPORTANT - READ BEFORE WORKING

## MANDATORY READING REQUIREMENT

Before starting ANY work on this system, you MUST:

1. Read `systemrules.md` - Contains all server IPs, SSH details, domain configuration
2. Read `global-Infrastructure.md` - Full infrastructure governance rules
3. Read `global-PROJECT_SETUP_GUIDELINES.md` - Project setup patterns
4. Follow ALL rules without exception
5. Update documentation when patterns change

---

## QUICK REFERENCE

### Server Connection
```bash
# Main Server (port 450)
ssh -i ~/.ssh/raywonder -p 450 root@64.20.46.178
ssh -i ~/.ssh/raywonder -p 450 devinecr@64.20.46.178

# VPS (port 22)
ssh -i ~/.ssh/raywonder devinecr@208.73.204.162
```

### Key Configuration
- **SSH Key**: raywonder (in ~/.ssh/)
- **Main Server**: 64.20.46.178-82, port 450
- **VPS**: 208.73.204.162, port 22
- **Primary User**: devinecr

### Nameservers (ALL DOMAINS)
- ns1.raywonderis.me → 64.20.46.178
- ns2.raywonderis.me → 64.20.46.179
- ns3.raywonderis.me → 64.20.46.180
- ns4.raywonderis.me → 64.20.46.181

---

## KEY FILES TO READ

### systemrules.md
- Server IPs, ports, SSH configuration
- Domain and nameserver details
- WHMCS account information
- Media server configuration
- All permanent infrastructure details

### global-Infrastructure.md
- ALL infrastructure governance rules
- Applies to ALL projects and environments
- Authoritative document that defines reality
- Rules for PM2, permissions, file organization
- Appendices with permanent configuration

### global-PROJECT_SETUP_GUIDELINES.md
- Specific project setup patterns
- Commands for PM2, nginx, troubleshooting
- Checklists for pre/post setup
- Template for status reports

---

## NON-NEGOTIABLE RULES

### Process Management
- PM2 is the ONLY process manager for Node apps
- systemd for Node apps is FORBIDDEN
- Never run applications as root

### Permissions
- Use devinecr:devinecr ownership
- Directories: 755
- Files: 644

### Firewall
- CSF is FORBIDDEN
- LFD is FORBIDDEN
- Use UFW or iptables only

### Ports
- NEVER use: 2082-2087, 2095, 2077 (cPanel reserved)
- Use: 3000-5000 for applications

---

## VIOLATIONS ARE NOT PERMITTED

These documents govern ALL work:
- AI agents
- Human developers
- Emergency fixes
- New projects
- Existing projects

**These files define reality for this server.**

---

## FILE LOCATIONS

### On Servers
```
/home/devinecr/apps/project-name/source/
/home/devinecr/apps/project-name/data/
/var/named/domain.db (DNS zones)
/etc/nginx/conf.d/ (nginx configs)
```

### Local Development
```
C:\Users\40493\dev\apps\
C:\Users\40493\.claude\CLAUDE.md
```

---

Last Updated: Thu Jan 30 04:10:00 EST 2026
