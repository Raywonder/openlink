/**
 * Accessible Dropdown Component for OpenLink
 * A VoiceOver-compatible custom dropdown that replaces native <select> elements
 * Uses ARIA listbox pattern for full screen reader support
 */

class AccessibleDropdown {
    constructor(selectElement, options = {}) {
        this.originalSelect = selectElement;
        this.options = {
            announceChanges: true,
            ...options
        };

        this.isOpen = false;
        this.selectedIndex = selectElement.selectedIndex || 0;
        this.id = selectElement.id || `dropdown-${Date.now()}`;

        this.init();
    }

    init() {
        // Create wrapper
        this.wrapper = document.createElement('div');
        this.wrapper.className = 'accessible-dropdown';
        this.wrapper.setAttribute('data-dropdown-id', this.id);

        // Create button (the trigger)
        this.button = document.createElement('button');
        this.button.type = 'button';
        this.button.className = 'dropdown-button';
        this.button.id = `${this.id}-button`;
        this.button.setAttribute('aria-haspopup', 'listbox');
        this.button.setAttribute('aria-expanded', 'false');
        this.button.setAttribute('aria-labelledby', this.getLabelId());

        // Create listbox
        this.listbox = document.createElement('ul');
        this.listbox.className = 'dropdown-listbox';
        this.listbox.id = `${this.id}-listbox`;
        this.listbox.setAttribute('role', 'listbox');
        this.listbox.setAttribute('aria-labelledby', `${this.id}-button`);
        this.listbox.setAttribute('tabindex', '-1');
        this.listbox.hidden = true;

        // Populate options
        this.populateOptions();

        // Set initial selection
        this.updateButtonText();

        // Insert into DOM
        this.originalSelect.parentNode.insertBefore(this.wrapper, this.originalSelect);
        this.wrapper.appendChild(this.button);
        this.wrapper.appendChild(this.listbox);

        // Hide original select but keep it for form submission
        this.originalSelect.style.display = 'none';
        this.originalSelect.setAttribute('aria-hidden', 'true');
        this.originalSelect.tabIndex = -1;

        // Bind events
        this.bindEvents();
    }

    getLabelId() {
        // Find associated label
        const label = document.querySelector(`label[for="${this.originalSelect.id}"]`);
        if (label) {
            if (!label.id) {
                label.id = `${this.id}-label`;
            }
            return label.id;
        }

        // Check for aria-label
        const ariaLabel = this.originalSelect.getAttribute('aria-label');
        if (ariaLabel) {
            this.button.setAttribute('aria-label', ariaLabel);
        }

        return null;
    }

    populateOptions() {
        this.listbox.innerHTML = '';
        const options = this.originalSelect.options;

        for (let i = 0; i < options.length; i++) {
            const option = options[i];
            const li = document.createElement('li');
            li.className = 'dropdown-option';
            li.id = `${this.id}-option-${i}`;
            li.setAttribute('role', 'option');
            li.setAttribute('data-value', option.value);
            li.setAttribute('data-index', i);
            li.textContent = option.textContent;

            if (i === this.selectedIndex) {
                li.setAttribute('aria-selected', 'true');
                li.classList.add('selected');
            } else {
                li.setAttribute('aria-selected', 'false');
            }

            this.listbox.appendChild(li);
        }
    }

    updateButtonText() {
        const selectedOption = this.originalSelect.options[this.selectedIndex];
        if (selectedOption) {
            this.button.textContent = selectedOption.textContent;
            this.button.setAttribute('aria-activedescendant', `${this.id}-option-${this.selectedIndex}`);
        }
    }

    bindEvents() {
        // Button click
        this.button.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.toggle();
        });

        // Button keyboard
        this.button.addEventListener('keydown', (e) => {
            this.handleButtonKeydown(e);
        });

        // Listbox keyboard
        this.listbox.addEventListener('keydown', (e) => {
            this.handleListboxKeydown(e);
        });

        // Option click
        this.listbox.addEventListener('click', (e) => {
            const option = e.target.closest('.dropdown-option');
            if (option) {
                const index = parseInt(option.getAttribute('data-index'), 10);
                this.selectOption(index);
                this.close();
                this.button.focus();
            }
        });

        // Close on outside click
        document.addEventListener('click', (e) => {
            if (this.isOpen && !this.wrapper.contains(e.target)) {
                this.close();
            }
        });

        // Close on escape anywhere
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.isOpen) {
                this.close();
                this.button.focus();
            }
        });
    }

    handleButtonKeydown(e) {
        switch (e.key) {
            case 'Enter':
            case ' ':
            case 'ArrowDown':
            case 'ArrowUp':
                e.preventDefault();
                this.open();
                break;
        }
    }

    handleListboxKeydown(e) {
        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault();
                this.focusNextOption();
                break;
            case 'ArrowUp':
                e.preventDefault();
                this.focusPreviousOption();
                break;
            case 'Home':
                e.preventDefault();
                this.focusOption(0);
                break;
            case 'End':
                e.preventDefault();
                this.focusOption(this.originalSelect.options.length - 1);
                break;
            case 'Enter':
            case ' ':
                e.preventDefault();
                this.selectFocusedOption();
                this.close();
                this.button.focus();
                break;
            case 'Escape':
                e.preventDefault();
                this.close();
                this.button.focus();
                break;
            case 'Tab':
                this.close();
                break;
            default:
                // Type-ahead search
                if (e.key.length === 1) {
                    this.typeAheadSearch(e.key);
                }
                break;
        }
    }

    open() {
        if (this.isOpen) return;

        this.isOpen = true;
        this.listbox.hidden = false;
        this.button.setAttribute('aria-expanded', 'true');
        this.listbox.setAttribute('aria-activedescendant', `${this.id}-option-${this.selectedIndex}`);

        // Focus the listbox
        this.listbox.focus();

        // Scroll selected option into view
        const selectedOption = this.listbox.querySelector('.selected');
        if (selectedOption) {
            selectedOption.scrollIntoView({ block: 'nearest' });
        }

        // Announce to screen reader
        this.announce('Dropdown opened. Use arrow keys to navigate, Enter to select, Escape to close.');
    }

    close() {
        if (!this.isOpen) return;

        this.isOpen = false;
        this.listbox.hidden = true;
        this.button.setAttribute('aria-expanded', 'false');
    }

    toggle() {
        if (this.isOpen) {
            this.close();
        } else {
            this.open();
        }
    }

    focusOption(index) {
        const options = this.listbox.querySelectorAll('.dropdown-option');
        if (index < 0 || index >= options.length) return;

        // Update visual focus
        options.forEach((opt, i) => {
            if (i === index) {
                opt.classList.add('focused');
                opt.scrollIntoView({ block: 'nearest' });
            } else {
                opt.classList.remove('focused');
            }
        });

        this.listbox.setAttribute('aria-activedescendant', `${this.id}-option-${index}`);

        // Announce option
        this.announce(options[index].textContent);
    }

    focusNextOption() {
        const currentFocused = this.listbox.querySelector('.focused');
        let nextIndex = 0;

        if (currentFocused) {
            nextIndex = parseInt(currentFocused.getAttribute('data-index'), 10) + 1;
        } else {
            nextIndex = this.selectedIndex + 1;
        }

        if (nextIndex >= this.originalSelect.options.length) {
            nextIndex = 0;
        }

        this.focusOption(nextIndex);
    }

    focusPreviousOption() {
        const currentFocused = this.listbox.querySelector('.focused');
        let prevIndex = this.originalSelect.options.length - 1;

        if (currentFocused) {
            prevIndex = parseInt(currentFocused.getAttribute('data-index'), 10) - 1;
        } else {
            prevIndex = this.selectedIndex - 1;
        }

        if (prevIndex < 0) {
            prevIndex = this.originalSelect.options.length - 1;
        }

        this.focusOption(prevIndex);
    }

    selectFocusedOption() {
        const focused = this.listbox.querySelector('.focused');
        if (focused) {
            const index = parseInt(focused.getAttribute('data-index'), 10);
            this.selectOption(index);
        }
    }

    selectOption(index) {
        const oldIndex = this.selectedIndex;
        this.selectedIndex = index;

        // Update original select
        this.originalSelect.selectedIndex = index;

        // Update visual selection
        const options = this.listbox.querySelectorAll('.dropdown-option');
        options.forEach((opt, i) => {
            if (i === index) {
                opt.setAttribute('aria-selected', 'true');
                opt.classList.add('selected');
            } else {
                opt.setAttribute('aria-selected', 'false');
                opt.classList.remove('selected');
            }
            opt.classList.remove('focused');
        });

        // Update button text
        this.updateButtonText();

        // Trigger change event on original select
        if (oldIndex !== index) {
            const event = new Event('change', { bubbles: true });
            this.originalSelect.dispatchEvent(event);

            // Announce selection
            if (this.options.announceChanges) {
                const selectedText = this.originalSelect.options[index].textContent;
                this.announce(`${selectedText} selected`);
            }
        }
    }

    typeAheadSearch(char) {
        const searchChar = char.toLowerCase();
        const options = this.listbox.querySelectorAll('.dropdown-option');

        // Find first option starting with this character after current position
        const currentFocused = this.listbox.querySelector('.focused');
        let startIndex = 0;

        if (currentFocused) {
            startIndex = parseInt(currentFocused.getAttribute('data-index'), 10) + 1;
        }

        for (let i = 0; i < options.length; i++) {
            const index = (startIndex + i) % options.length;
            const optionText = options[index].textContent.toLowerCase();

            if (optionText.startsWith(searchChar)) {
                this.focusOption(index);
                return;
            }
        }
    }

    announce(message) {
        // Use existing announcer if available
        const announcer = document.getElementById('sr-announcer');
        if (announcer) {
            announcer.textContent = message;
            // Clear after a moment to allow re-announcement
            setTimeout(() => {
                announcer.textContent = '';
            }, 100);
        }
    }

    // Public method to update options dynamically
    refresh() {
        this.populateOptions();
        this.updateButtonText();
    }

    // Public method to set value programmatically
    setValue(value) {
        const options = this.originalSelect.options;
        for (let i = 0; i < options.length; i++) {
            if (options[i].value === value) {
                this.selectOption(i);
                return;
            }
        }
    }

    // Destroy and restore original select
    destroy() {
        this.originalSelect.style.display = '';
        this.originalSelect.removeAttribute('aria-hidden');
        this.originalSelect.tabIndex = 0;
        this.wrapper.remove();
    }
}

/**
 * Initialize all select elements with accessible dropdowns
 */
function initAccessibleDropdowns(selector = 'select') {
    const selects = document.querySelectorAll(selector);
    const dropdowns = [];

    selects.forEach(select => {
        // Skip if already converted
        if (select.hasAttribute('data-accessible-converted')) {
            return;
        }

        select.setAttribute('data-accessible-converted', 'true');
        const dropdown = new AccessibleDropdown(select);
        dropdowns.push(dropdown);
    });

    console.log(`Initialized ${dropdowns.length} accessible dropdowns`);
    return dropdowns;
}

// Export for use in app.js
window.AccessibleDropdown = AccessibleDropdown;
window.initAccessibleDropdowns = initAccessibleDropdowns;
