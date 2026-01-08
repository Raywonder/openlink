<?php
/**
 * Plugin Name: OpenLink Server
 * Plugin URI: https://raywonderis.me/apps/openlink
 * Description: Run an OpenLink relay server from your WordPress site. Provides relay hosting for OpenLink remote desktop connections.
 * Version: 1.0.0
 * Author: Devine Creations
 * Author URI: https://devine-creations.com
 * License: MIT
 * Text Domain: openlink-server
 */

if (!defined('ABSPATH')) {
    exit; // Exit if accessed directly
}

define('OPENLINK_VERSION', '1.0.0');
define('OPENLINK_PLUGIN_DIR', plugin_dir_path(__FILE__));
define('OPENLINK_PLUGIN_URL', plugin_dir_url(__FILE__));

/**
 * OpenLink Server Plugin Main Class
 */
class OpenLink_Server {

    /**
     * Instance of this class
     */
    private static $instance = null;

    /**
     * Server options
     */
    private $options;

    /**
     * Get singleton instance
     */
    public static function get_instance() {
        if (null === self::$instance) {
            self::$instance = new self();
        }
        return self::$instance;
    }

    /**
     * Constructor
     */
    private function __construct() {
        $this->options = get_option('openlink_options', $this->get_default_options());

        // Hooks
        add_action('admin_menu', array($this, 'add_admin_menu'));
        add_action('admin_init', array($this, 'register_settings'));
        add_action('rest_api_init', array($this, 'register_rest_routes'));
        add_action('wp_enqueue_scripts', array($this, 'enqueue_scripts'));
        add_action('admin_enqueue_scripts', array($this, 'admin_enqueue_scripts'));

        // Shortcodes
        add_shortcode('openlink_status', array($this, 'status_shortcode'));
        add_shortcode('openlink_connect', array($this, 'connect_shortcode'));
        add_shortcode('openlink_servers', array($this, 'servers_shortcode'));
    }

    /**
     * Default options
     */
    private function get_default_options() {
        return array(
            'server_enabled' => false,
            'server_name' => get_bloginfo('name') . ' OpenLink Server',
            'server_port' => 8765,
            'is_public' => true,
            'access_mode' => 'public',
            'pin_code' => '',
            'require_connection_pin' => false,
            'max_connections' => 50,
            'verification' => array(
                'mastodon' => '',
                'twitter' => '',
                'github' => '',
                'website' => get_site_url(),
                'email' => get_option('admin_email'),
                'organization' => get_bloginfo('name')
            ),
            'trusted_hosts' => array(),
            'banned_ips' => array()
        );
    }

    /**
     * Add admin menu
     */
    public function add_admin_menu() {
        add_menu_page(
            __('OpenLink Server', 'openlink-server'),
            __('OpenLink', 'openlink-server'),
            'manage_options',
            'openlink-server',
            array($this, 'admin_page'),
            'dashicons-networking',
            80
        );

        add_submenu_page(
            'openlink-server',
            __('Settings', 'openlink-server'),
            __('Settings', 'openlink-server'),
            'manage_options',
            'openlink-settings',
            array($this, 'settings_page')
        );

        add_submenu_page(
            'openlink-server',
            __('Connections', 'openlink-server'),
            __('Connections', 'openlink-server'),
            'manage_options',
            'openlink-connections',
            array($this, 'connections_page')
        );

        add_submenu_page(
            'openlink-server',
            __('Servers', 'openlink-server'),
            __('Servers', 'openlink-server'),
            'manage_options',
            'openlink-servers',
            array($this, 'servers_page')
        );
    }

    /**
     * Register settings
     */
    public function register_settings() {
        register_setting('openlink_options', 'openlink_options', array($this, 'sanitize_options'));

        // Server Section
        add_settings_section(
            'openlink_server_section',
            __('Server Settings', 'openlink-server'),
            array($this, 'server_section_callback'),
            'openlink-settings'
        );

        add_settings_field(
            'server_enabled',
            __('Enable Server', 'openlink-server'),
            array($this, 'checkbox_field_callback'),
            'openlink-settings',
            'openlink_server_section',
            array('field' => 'server_enabled', 'label' => __('Enable OpenLink relay server', 'openlink-server'))
        );

        add_settings_field(
            'server_name',
            __('Server Name', 'openlink-server'),
            array($this, 'text_field_callback'),
            'openlink-settings',
            'openlink_server_section',
            array('field' => 'server_name', 'placeholder' => 'My OpenLink Server')
        );

        add_settings_field(
            'is_public',
            __('Public Server', 'openlink-server'),
            array($this, 'checkbox_field_callback'),
            'openlink-settings',
            'openlink_server_section',
            array('field' => 'is_public', 'label' => __('Allow server to be discovered publicly', 'openlink-server'))
        );

        add_settings_field(
            'access_mode',
            __('Access Mode', 'openlink-server'),
            array($this, 'select_field_callback'),
            'openlink-settings',
            'openlink_server_section',
            array(
                'field' => 'access_mode',
                'options' => array(
                    'public' => __('Public - Anyone can connect', 'openlink-server'),
                    'pin' => __('PIN Code Required', 'openlink-server'),
                    'password' => __('Password Required', 'openlink-server'),
                    'registered' => __('Registered Users Only', 'openlink-server'),
                    'whitelist' => __('Whitelist Only', 'openlink-server')
                )
            )
        );

        // Verification Section
        add_settings_section(
            'openlink_verification_section',
            __('Server Verification', 'openlink-server'),
            array($this, 'verification_section_callback'),
            'openlink-settings'
        );

        $verification_fields = array(
            'mastodon' => __('Mastodon Handle', 'openlink-server'),
            'twitter' => __('Twitter/X Handle', 'openlink-server'),
            'github' => __('GitHub Username', 'openlink-server'),
            'organization' => __('Organization Name', 'openlink-server')
        );

        foreach ($verification_fields as $field => $label) {
            add_settings_field(
                'verification_' . $field,
                $label,
                array($this, 'verification_field_callback'),
                'openlink-settings',
                'openlink_verification_section',
                array('field' => $field)
            );
        }
    }

    /**
     * Sanitize options
     */
    public function sanitize_options($input) {
        $sanitized = array();

        $sanitized['server_enabled'] = !empty($input['server_enabled']);
        $sanitized['server_name'] = sanitize_text_field($input['server_name'] ?? '');
        $sanitized['server_port'] = absint($input['server_port'] ?? 8765);
        $sanitized['is_public'] = !empty($input['is_public']);
        $sanitized['access_mode'] = sanitize_text_field($input['access_mode'] ?? 'public');
        $sanitized['pin_code'] = sanitize_text_field($input['pin_code'] ?? '');
        $sanitized['require_connection_pin'] = !empty($input['require_connection_pin']);
        $sanitized['max_connections'] = absint($input['max_connections'] ?? 50);

        // Verification
        $sanitized['verification'] = array(
            'mastodon' => sanitize_text_field($input['verification']['mastodon'] ?? ''),
            'twitter' => sanitize_text_field($input['verification']['twitter'] ?? ''),
            'github' => sanitize_text_field($input['verification']['github'] ?? ''),
            'website' => esc_url_raw($input['verification']['website'] ?? get_site_url()),
            'email' => sanitize_email($input['verification']['email'] ?? ''),
            'organization' => sanitize_text_field($input['verification']['organization'] ?? '')
        );

        return $sanitized;
    }

    /**
     * Register REST API routes
     */
    public function register_rest_routes() {
        register_rest_route('openlink/v1', '/status', array(
            'methods' => 'GET',
            'callback' => array($this, 'api_status'),
            'permission_callback' => '__return_true'
        ));

        register_rest_route('openlink/v1', '/servers', array(
            'methods' => 'GET',
            'callback' => array($this, 'api_servers'),
            'permission_callback' => '__return_true'
        ));

        register_rest_route('openlink/v1', '/connect', array(
            'methods' => 'POST',
            'callback' => array($this, 'api_connect'),
            'permission_callback' => array($this, 'check_connect_permission')
        ));

        register_rest_route('openlink/v1', '/report', array(
            'methods' => 'POST',
            'callback' => array($this, 'api_report'),
            'permission_callback' => 'is_user_logged_in'
        ));

        register_rest_route('openlink/v1', '/config', array(
            'methods' => 'GET',
            'callback' => array($this, 'api_config'),
            'permission_callback' => array($this, 'check_admin_permission')
        ));

        register_rest_route('openlink/v1', '/config', array(
            'methods' => 'POST',
            'callback' => array($this, 'api_update_config'),
            'permission_callback' => array($this, 'check_admin_permission')
        ));
    }

    /**
     * API: Get server status
     */
    public function api_status($request) {
        return rest_ensure_response(array(
            'running' => $this->options['server_enabled'],
            'name' => $this->options['server_name'],
            'isPublic' => $this->options['is_public'],
            'accessMode' => $this->options['access_mode'],
            'verification' => $this->options['verification'],
            'trustScore' => $this->calculate_trust_score(),
            'version' => OPENLINK_VERSION
        ));
    }

    /**
     * API: Get known servers
     */
    public function api_servers($request) {
        $servers = get_option('openlink_known_servers', array());

        // Add default public servers
        $default_servers = array(
            array(
                'url' => 'wss://openlink.raywonderis.me',
                'name' => 'OpenLink Main Server',
                'isPublic' => true,
                'verified' => true
            )
        );

        return rest_ensure_response(array_merge($default_servers, $servers));
    }

    /**
     * API: Connect to server
     */
    public function api_connect($request) {
        $params = $request->get_json_params();

        // Validate access
        if ($this->options['access_mode'] === 'pin') {
            if (empty($params['pin']) || $params['pin'] !== $this->options['pin_code']) {
                return new WP_Error('invalid_pin', __('Invalid PIN code', 'openlink-server'), array('status' => 403));
            }
        }

        if ($this->options['access_mode'] === 'registered' && !is_user_logged_in()) {
            return new WP_Error('not_logged_in', __('Must be logged in', 'openlink-server'), array('status' => 403));
        }

        // Return connection info
        return rest_ensure_response(array(
            'success' => true,
            'server' => array(
                'url' => get_site_url() . ':' . $this->options['server_port'],
                'name' => $this->options['server_name'],
                'verification' => $this->options['verification']
            )
        ));
    }

    /**
     * API: Report a server
     */
    public function api_report($request) {
        $params = $request->get_json_params();

        if (empty($params['server_url']) || empty($params['reason'])) {
            return new WP_Error('missing_params', __('Missing required parameters', 'openlink-server'), array('status' => 400));
        }

        $reports = get_option('openlink_reports', array());
        $reports[] = array(
            'server_url' => sanitize_text_field($params['server_url']),
            'reason' => sanitize_text_field($params['reason']),
            'reporter' => get_current_user_id(),
            'timestamp' => current_time('mysql')
        );

        update_option('openlink_reports', $reports);

        // Check if server should be auto-banned (3+ reports)
        $server_reports = array_filter($reports, function($r) use ($params) {
            return $r['server_url'] === $params['server_url'];
        });

        if (count($server_reports) >= 3) {
            $this->ban_server($params['server_url']);
        }

        return rest_ensure_response(array('success' => true));
    }

    /**
     * API: Get config (admin only)
     */
    public function api_config($request) {
        return rest_ensure_response($this->options);
    }

    /**
     * API: Update config (admin only)
     */
    public function api_update_config($request) {
        $params = $request->get_json_params();
        $updated = $this->sanitize_options(array_merge($this->options, $params));

        update_option('openlink_options', $updated);
        $this->options = $updated;

        return rest_ensure_response(array('success' => true, 'config' => $updated));
    }

    /**
     * Check connection permission
     */
    public function check_connect_permission($request) {
        if (!$this->options['server_enabled']) {
            return new WP_Error('server_disabled', __('Server is not running', 'openlink-server'), array('status' => 503));
        }
        return true;
    }

    /**
     * Check admin permission
     */
    public function check_admin_permission($request) {
        return current_user_can('manage_options');
    }

    /**
     * Calculate trust score
     */
    private function calculate_trust_score() {
        $score = 0;
        $v = $this->options['verification'];

        if (!empty($v['mastodon'])) $score += 20;
        if (!empty($v['twitter'])) $score += 15;
        if (!empty($v['github'])) $score += 20;
        if (!empty($v['website'])) $score += 15;
        if (!empty($v['email'])) $score += 10;
        if (!empty($v['organization'])) $score += 20;

        // Bonus for SSL
        if (is_ssl()) $score += 10;

        return min($score, 100);
    }

    /**
     * Ban a server
     */
    private function ban_server($server_url) {
        $banned = get_option('openlink_banned_servers', array());
        if (!in_array($server_url, $banned)) {
            $banned[] = $server_url;
            update_option('openlink_banned_servers', $banned);

            // Send notification
            wp_mail(
                get_option('admin_email'),
                __('[OpenLink] Server Auto-Banned', 'openlink-server'),
                sprintf(__('The server %s has been auto-banned after receiving 3+ reports.', 'openlink-server'), $server_url)
            );
        }
    }

    /**
     * Enqueue frontend scripts
     */
    public function enqueue_scripts() {
        wp_enqueue_style(
            'openlink-frontend',
            OPENLINK_PLUGIN_URL . 'assets/css/frontend.css',
            array(),
            OPENLINK_VERSION
        );

        wp_enqueue_script(
            'openlink-frontend',
            OPENLINK_PLUGIN_URL . 'assets/js/frontend.js',
            array('jquery'),
            OPENLINK_VERSION,
            true
        );

        wp_localize_script('openlink-frontend', 'openlink', array(
            'ajaxurl' => admin_url('admin-ajax.php'),
            'resturl' => rest_url('openlink/v1/'),
            'nonce' => wp_create_nonce('wp_rest')
        ));
    }

    /**
     * Enqueue admin scripts
     */
    public function admin_enqueue_scripts($hook) {
        if (strpos($hook, 'openlink') === false) {
            return;
        }

        wp_enqueue_style(
            'openlink-admin',
            OPENLINK_PLUGIN_URL . 'assets/css/admin.css',
            array(),
            OPENLINK_VERSION
        );

        wp_enqueue_script(
            'openlink-admin',
            OPENLINK_PLUGIN_URL . 'assets/js/admin.js',
            array('jquery'),
            OPENLINK_VERSION,
            true
        );
    }

    /**
     * Shortcode: Server status
     */
    public function status_shortcode($atts) {
        $atts = shortcode_atts(array(
            'show_name' => true,
            'show_trust' => true
        ), $atts);

        ob_start();
        ?>
        <div class="openlink-status-widget" data-show-name="<?php echo esc_attr($atts['show_name']); ?>" data-show-trust="<?php echo esc_attr($atts['show_trust']); ?>">
            <div class="openlink-status-indicator">
                <span class="status-dot <?php echo $this->options['server_enabled'] ? 'online' : 'offline'; ?>"></span>
                <span class="status-text"><?php echo $this->options['server_enabled'] ? __('Online', 'openlink-server') : __('Offline', 'openlink-server'); ?></span>
            </div>
            <?php if ($atts['show_name']): ?>
            <div class="openlink-server-name"><?php echo esc_html($this->options['server_name']); ?></div>
            <?php endif; ?>
            <?php if ($atts['show_trust']): ?>
            <div class="openlink-trust-score">
                <?php printf(__('Trust Score: %d/100', 'openlink-server'), $this->calculate_trust_score()); ?>
            </div>
            <?php endif; ?>
        </div>
        <?php
        return ob_get_clean();
    }

    /**
     * Shortcode: Connect button
     */
    public function connect_shortcode($atts) {
        $atts = shortcode_atts(array(
            'text' => __('Connect via OpenLink', 'openlink-server'),
            'class' => 'openlink-connect-btn'
        ), $atts);

        return sprintf(
            '<button class="%s" data-server="%s">%s</button>',
            esc_attr($atts['class']),
            esc_url(get_site_url()),
            esc_html($atts['text'])
        );
    }

    /**
     * Shortcode: Server list
     */
    public function servers_shortcode($atts) {
        ob_start();
        ?>
        <div class="openlink-servers-list">
            <h3><?php _e('Available OpenLink Servers', 'openlink-server'); ?></h3>
            <div class="servers-loading"><?php _e('Loading servers...', 'openlink-server'); ?></div>
            <ul class="servers-list" style="display: none;"></ul>
        </div>
        <?php
        return ob_get_clean();
    }

    /**
     * Admin page: Dashboard
     */
    public function admin_page() {
        ?>
        <div class="wrap openlink-admin">
            <h1><?php _e('OpenLink Server Dashboard', 'openlink-server'); ?></h1>

            <div class="openlink-dashboard">
                <div class="dashboard-card status-card">
                    <h2><?php _e('Server Status', 'openlink-server'); ?></h2>
                    <div class="status-indicator <?php echo $this->options['server_enabled'] ? 'online' : 'offline'; ?>">
                        <span class="dot"></span>
                        <span><?php echo $this->options['server_enabled'] ? __('Running', 'openlink-server') : __('Stopped', 'openlink-server'); ?></span>
                    </div>
                    <div class="quick-stats">
                        <div class="stat">
                            <span class="stat-value"><?php echo esc_html($this->options['server_name']); ?></span>
                            <span class="stat-label"><?php _e('Server Name', 'openlink-server'); ?></span>
                        </div>
                        <div class="stat">
                            <span class="stat-value"><?php echo $this->options['is_public'] ? __('Yes', 'openlink-server') : __('No', 'openlink-server'); ?></span>
                            <span class="stat-label"><?php _e('Public', 'openlink-server'); ?></span>
                        </div>
                        <div class="stat">
                            <span class="stat-value"><?php echo $this->calculate_trust_score(); ?>/100</span>
                            <span class="stat-label"><?php _e('Trust Score', 'openlink-server'); ?></span>
                        </div>
                    </div>
                </div>

                <div class="dashboard-card">
                    <h2><?php _e('Quick Actions', 'openlink-server'); ?></h2>
                    <form method="post" action="">
                        <?php wp_nonce_field('openlink_toggle', 'openlink_nonce'); ?>
                        <button type="submit" name="toggle_server" class="button button-primary">
                            <?php echo $this->options['server_enabled'] ? __('Stop Server', 'openlink-server') : __('Start Server', 'openlink-server'); ?>
                        </button>
                    </form>
                    <p>
                        <a href="<?php echo admin_url('admin.php?page=openlink-settings'); ?>" class="button">
                            <?php _e('Server Settings', 'openlink-server'); ?>
                        </a>
                        <a href="<?php echo admin_url('admin.php?page=openlink-connections'); ?>" class="button">
                            <?php _e('View Connections', 'openlink-server'); ?>
                        </a>
                    </p>
                </div>

                <div class="dashboard-card">
                    <h2><?php _e('Verification Links', 'openlink-server'); ?></h2>
                    <ul class="verification-list">
                        <?php foreach ($this->options['verification'] as $key => $value): ?>
                            <?php if (!empty($value)): ?>
                            <li><strong><?php echo esc_html(ucfirst($key)); ?>:</strong> <?php echo esc_html($value); ?></li>
                            <?php endif; ?>
                        <?php endforeach; ?>
                    </ul>
                </div>

                <div class="dashboard-card full-width">
                    <h2><?php _e('Shortcodes', 'openlink-server'); ?></h2>
                    <table class="widefat">
                        <tr>
                            <td><code>[openlink_status]</code></td>
                            <td><?php _e('Display server status widget', 'openlink-server'); ?></td>
                        </tr>
                        <tr>
                            <td><code>[openlink_connect]</code></td>
                            <td><?php _e('Display connect button', 'openlink-server'); ?></td>
                        </tr>
                        <tr>
                            <td><code>[openlink_servers]</code></td>
                            <td><?php _e('Display list of available servers', 'openlink-server'); ?></td>
                        </tr>
                    </table>
                </div>
            </div>
        </div>
        <?php
    }

    /**
     * Admin page: Settings
     */
    public function settings_page() {
        ?>
        <div class="wrap">
            <h1><?php _e('OpenLink Server Settings', 'openlink-server'); ?></h1>
            <form method="post" action="options.php">
                <?php
                settings_fields('openlink_options');
                do_settings_sections('openlink-settings');
                submit_button();
                ?>
            </form>
        </div>
        <?php
    }

    /**
     * Admin page: Connections
     */
    public function connections_page() {
        ?>
        <div class="wrap">
            <h1><?php _e('OpenLink Connections', 'openlink-server'); ?></h1>
            <p><?php _e('View and manage active connections to your OpenLink server.', 'openlink-server'); ?></p>
            <table class="wp-list-table widefat fixed striped">
                <thead>
                    <tr>
                        <th><?php _e('Client ID', 'openlink-server'); ?></th>
                        <th><?php _e('IP Address', 'openlink-server'); ?></th>
                        <th><?php _e('Connected', 'openlink-server'); ?></th>
                        <th><?php _e('Actions', 'openlink-server'); ?></th>
                    </tr>
                </thead>
                <tbody id="connections-list">
                    <tr><td colspan="4"><?php _e('No active connections', 'openlink-server'); ?></td></tr>
                </tbody>
            </table>
        </div>
        <?php
    }

    /**
     * Admin page: Servers
     */
    public function servers_page() {
        ?>
        <div class="wrap">
            <h1><?php _e('Known OpenLink Servers', 'openlink-server'); ?></h1>
            <p><?php _e('Manage trusted and banned OpenLink servers.', 'openlink-server'); ?></p>

            <h2><?php _e('Trusted Servers', 'openlink-server'); ?></h2>
            <table class="wp-list-table widefat fixed striped">
                <thead>
                    <tr>
                        <th><?php _e('Server URL', 'openlink-server'); ?></th>
                        <th><?php _e('Name', 'openlink-server'); ?></th>
                        <th><?php _e('Trust Score', 'openlink-server'); ?></th>
                        <th><?php _e('Actions', 'openlink-server'); ?></th>
                    </tr>
                </thead>
                <tbody>
                    <?php
                    $servers = get_option('openlink_known_servers', array());
                    if (empty($servers)):
                    ?>
                    <tr><td colspan="4"><?php _e('No trusted servers configured', 'openlink-server'); ?></td></tr>
                    <?php else: foreach ($servers as $server): ?>
                    <tr>
                        <td><?php echo esc_html($server['url']); ?></td>
                        <td><?php echo esc_html($server['name'] ?? '-'); ?></td>
                        <td><?php echo esc_html($server['trust_score'] ?? '-'); ?></td>
                        <td>
                            <button class="button" onclick="removeServer('<?php echo esc_js($server['url']); ?>')">
                                <?php _e('Remove', 'openlink-server'); ?>
                            </button>
                        </td>
                    </tr>
                    <?php endforeach; endif; ?>
                </tbody>
            </table>

            <h2><?php _e('Banned Servers', 'openlink-server'); ?></h2>
            <table class="wp-list-table widefat fixed striped">
                <thead>
                    <tr>
                        <th><?php _e('Server URL', 'openlink-server'); ?></th>
                        <th><?php _e('Reason', 'openlink-server'); ?></th>
                        <th><?php _e('Actions', 'openlink-server'); ?></th>
                    </tr>
                </thead>
                <tbody>
                    <?php
                    $banned = get_option('openlink_banned_servers', array());
                    if (empty($banned)):
                    ?>
                    <tr><td colspan="3"><?php _e('No banned servers', 'openlink-server'); ?></td></tr>
                    <?php else: foreach ($banned as $url): ?>
                    <tr>
                        <td><?php echo esc_html($url); ?></td>
                        <td><?php _e('Multiple reports', 'openlink-server'); ?></td>
                        <td>
                            <button class="button" onclick="unbanServer('<?php echo esc_js($url); ?>')">
                                <?php _e('Unban', 'openlink-server'); ?>
                            </button>
                        </td>
                    </tr>
                    <?php endforeach; endif; ?>
                </tbody>
            </table>
        </div>
        <?php
    }

    /**
     * Settings field callbacks
     */
    public function server_section_callback() {
        echo '<p>' . __('Configure your OpenLink relay server settings.', 'openlink-server') . '</p>';
    }

    public function verification_section_callback() {
        echo '<p>' . __('Add verification links to help users trust your server.', 'openlink-server') . '</p>';
    }

    public function checkbox_field_callback($args) {
        $value = $this->options[$args['field']] ?? false;
        ?>
        <label>
            <input type="checkbox" name="openlink_options[<?php echo esc_attr($args['field']); ?>]" value="1" <?php checked($value, true); ?>>
            <?php echo esc_html($args['label']); ?>
        </label>
        <?php
    }

    public function text_field_callback($args) {
        $value = $this->options[$args['field']] ?? '';
        ?>
        <input type="text" name="openlink_options[<?php echo esc_attr($args['field']); ?>]" value="<?php echo esc_attr($value); ?>" placeholder="<?php echo esc_attr($args['placeholder'] ?? ''); ?>" class="regular-text">
        <?php
    }

    public function select_field_callback($args) {
        $value = $this->options[$args['field']] ?? '';
        ?>
        <select name="openlink_options[<?php echo esc_attr($args['field']); ?>]">
            <?php foreach ($args['options'] as $key => $label): ?>
            <option value="<?php echo esc_attr($key); ?>" <?php selected($value, $key); ?>><?php echo esc_html($label); ?></option>
            <?php endforeach; ?>
        </select>
        <?php
    }

    public function verification_field_callback($args) {
        $value = $this->options['verification'][$args['field']] ?? '';
        ?>
        <input type="text" name="openlink_options[verification][<?php echo esc_attr($args['field']); ?>]" value="<?php echo esc_attr($value); ?>" class="regular-text">
        <?php
    }
}

// Initialize
OpenLink_Server::get_instance();

// Activation hook
register_activation_hook(__FILE__, function() {
    add_option('openlink_options', array(
        'server_enabled' => false,
        'server_name' => get_bloginfo('name') . ' OpenLink Server',
        'is_public' => true,
        'access_mode' => 'public',
        'verification' => array(
            'website' => get_site_url(),
            'email' => get_option('admin_email'),
            'organization' => get_bloginfo('name')
        )
    ));

    // Create assets directories
    $upload_dir = wp_upload_dir();
    $openlink_dir = $upload_dir['basedir'] . '/openlink';
    if (!file_exists($openlink_dir)) {
        wp_mkdir_p($openlink_dir);
    }
});

// Deactivation hook
register_deactivation_hook(__FILE__, function() {
    // Clean up if needed
});
