/**
 * openlink Bug Tracker JavaScript
 * Handles issue management, file operations, and remote synchronization
 */

class AppTracker {
    constructor(config) {
        this.config = config;
        this.issues = [];
        this.currentTab = 'issues';
        this.loadIssues();
    }

    initialize() {
        this.setupEventListeners();
        this.loadIssues();
        this.updateIssuesDisplay();
        console.log('📱 App Tracker initialized for openlink');
    }

    setupEventListeners() {
        // Form submission
        document.getElementById('new-issue-form')?.addEventListener('submit', (e) => {
            e.preventDefault();
            this.createIssue();
        });

        // Filter controls
        document.getElementById('status-filter')?.addEventListener('change', () => {
            this.filterIssues();
        });

        document.getElementById('priority-filter')?.addEventListener('change', () => {
            this.filterIssues();
        });

        document.getElementById('search-issues')?.addEventListener('input', (e) => {
            this.searchIssues(e.target.value);
        });
    }

    showTab(tabName) {
        // Hide all tabs
        document.querySelectorAll('.tab-content').forEach(tab => {
            tab.classList.remove('active');
        });

        // Remove active from all tab buttons
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.classList.remove('active');
        });

        // Show selected tab
        document.getElementById(tabName + '-tab')?.classList.add('active');

        // Activate tab button
        document.querySelector(`[onclick="appTracker.showTab('${tabName}')"]`)?.classList.add('active');

        this.currentTab = tabName;

        // Load tab-specific content
        switch(tabName) {
            case 'issues':
                this.updateIssuesDisplay();
                break;
            case 'files':
                fileManager.refreshFiles();
                break;
            case 'team':
                teamManager.refreshTeamData();
                break;
            case 'deploy':
                deploy.updateStatus();
                break;
            case 'logs':
                logger.refreshLogs();
                break;
        }
    }

    showNewIssue() {
        document.getElementById('new-issue-modal').style.display = 'block';
    }

    hideModal() {
        document.getElementById('new-issue-modal').style.display = 'none';
    }

    createIssue() {
        const title = document.getElementById('issue-title').value;
        const description = document.getElementById('issue-description').value;
        const priority = document.getElementById('issue-priority').value;
        const type = document.getElementById('issue-type').value;

        const issue = {
            id: Date.now(),
            title,
            description,
            priority,
            type,
            status: 'open',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            app: this.config.name
        };

        this.issues.push(issue);
        this.saveIssues();
        this.updateIssuesDisplay();
        this.hideModal();

        // Clear form
        document.getElementById('new-issue-form').reset();

        this.showToast('Issue created successfully', 'success');
    }

    updateIssue(issueId, updates) {
        const issue = this.issues.find(i => i.id === issueId);
        if (issue) {
            Object.assign(issue, updates, { updatedAt: new Date().toISOString() });
            this.saveIssues();
            this.updateIssuesDisplay();
            this.showToast('Issue updated', 'success');
        }
    }

    deleteIssue(issueId) {
        if (confirm('Are you sure you want to delete this issue?')) {
            this.issues = this.issues.filter(i => i.id !== issueId);
            this.saveIssues();
            this.updateIssuesDisplay();
            this.showToast('Issue deleted', 'info');
        }
    }

    loadIssues() {
        const stored = localStorage.getItem(`${this.config.name}-issues`);
        if (stored) {
            this.issues = JSON.parse(stored);
        }
    }

    saveIssues() {
        localStorage.setItem(`${this.config.name}-issues`, JSON.stringify(this.issues));
    }

    updateIssuesDisplay() {
        const container = document.getElementById('issues-list');
        if (!container) return;

        if (this.issues.length === 0) {
            container.innerHTML = `
                <div class="no-issues">
                    <div class="no-issues-icon">🎉</div>
                    <div class="no-issues-text">No issues found!</div>
                    <button class="btn btn-primary" onclick="appTracker.showNewIssue()">Create First Issue</button>
                </div>`;
            return;
        }

        const issuesHTML = this.issues.map(issue => `
            <div class="issue-card ${issue.priority}" data-issue-id="${issue.id}">
                <div class="issue-header">
                    <div class="issue-title">${this.escapeHtml(issue.title)}</div>
                    <div class="issue-meta">
                        <span class="issue-type type-${issue.type}">${issue.type}</span>
                        <span class="issue-priority priority-${issue.priority}">${issue.priority}</span>
                        <span class="issue-status status-${issue.status}">${issue.status}</span>
                    </div>
                </div>
                <div class="issue-description">
                    ${this.escapeHtml(issue.description).replace(/\n/g, '<br>')}
                </div>
                <div class="issue-footer">
                    <div class="issue-date">
                        Created: ${new Date(issue.createdAt).toLocaleDateString()}
                    </div>
                    <div class="issue-actions">
                        <button class="btn-small btn-secondary" onclick="appTracker.editIssue(${issue.id})">✏️ Edit</button>
                        <button class="btn-small btn-danger" onclick="appTracker.deleteIssue(${issue.id})">🗑️ Delete</button>
                    </div>
                </div>
            </div>
        `).join('');

        container.innerHTML = issuesHTML;
    }

    filterIssues() {
        const statusFilter = document.getElementById('status-filter').value;
        const priorityFilter = document.getElementById('priority-filter').value;

        document.querySelectorAll('.issue-card').forEach(card => {
            const issueId = parseInt(card.dataset.issueId);
            const issue = this.issues.find(i => i.id === issueId);

            const showStatus = statusFilter === 'all' || issue.status === statusFilter;
            const showPriority = priorityFilter === 'all' || issue.priority === priorityFilter;

            card.style.display = (showStatus && showPriority) ? 'block' : 'none';
        });
    }

    searchIssues(query) {
        const lowerQuery = query.toLowerCase();

        document.querySelectorAll('.issue-card').forEach(card => {
            const issueId = parseInt(card.dataset.issueId);
            const issue = this.issues.find(i => i.id === issueId);

            const matchesTitle = issue.title.toLowerCase().includes(lowerQuery);
            const matchesDescription = issue.description.toLowerCase().includes(lowerQuery);

            card.style.display = (matchesTitle || matchesDescription) ? 'block' : 'none';
        });
    }

    editIssue(issueId) {
        const issue = this.issues.find(i => i.id === issueId);
        if (!issue) return;

        // Populate edit form (you could create a dedicated edit modal)
        document.getElementById('issue-title').value = issue.title;
        document.getElementById('issue-description').value = issue.description;
        document.getElementById('issue-priority').value = issue.priority;
        document.getElementById('issue-type').value = issue.type;

        // Show modal and change form behavior for editing
        this.showNewIssue();

        // Replace form submission handler for editing
        const form = document.getElementById('new-issue-form');
        form.onsubmit = (e) => {
            e.preventDefault();
            this.updateIssue(issueId, {
                title: document.getElementById('issue-title').value,
                description: document.getElementById('issue-description').value,
                priority: document.getElementById('issue-priority').value,
                type: document.getElementById('issue-type').value
            });

            // Restore original form handler
            form.onsubmit = null;
            this.hideModal();
        };
    }

    showFileManager() {
        this.showTab('files');
    }

    showOwnershipManager() {
        this.showTab('team');
    }

    syncRemote() {
        fileManager.syncToRemote();
    }

    escapeHtml(unsafe) {
        return unsafe
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    showToast(message, type = 'info') {
        // Create toast notification
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.textContent = message;

        // Add to page
        document.body.appendChild(toast);

        // Show and auto-hide
        setTimeout(() => toast.classList.add('show'), 100);
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => document.body.removeChild(toast), 300);
        }, 3000);
    }
}