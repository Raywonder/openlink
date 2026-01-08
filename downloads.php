<?php
/**
 * OpenLink Downloads Integration with Composr CMS
 * Generates proper Composr URLs for download content
 */

// Include Composr core if available
$composr_path = dirname(dirname(dirname(__FILE__))) . '/sources/global.php';
if (file_exists($composr_path)) {
    require_once($composr_path);
}

/**
 * Generate Composr download URLs
 */
function get_openlink_download_urls() {
    $base_url = get_base_url();
    
    return [
        'windows' => [
            'url' => build_url(array('page' => 'downloads', 'type' => 'misc', 'id' => 'openlink-windows'), get_module_zone('downloads')),
            'direct_url' => $base_url . '/uploads/website_specific/apps/OpenLink/clients/windows/',
            'title' => 'OpenLink for Windows',
            'description' => 'Desktop application for Windows 10 and later',
            'file_types' => ['exe', 'zip'],
            'icon' => 'fab fa-windows'
        ],
        'mac' => [
            'url' => build_url(array('page' => 'downloads', 'type' => 'misc', 'id' => 'openlink-mac'), get_module_zone('downloads')),
            'direct_url' => $base_url . '/uploads/website_specific/apps/OpenLink/clients/mac/',
            'title' => 'OpenLink for macOS',
            'description' => 'Desktop application for macOS 10.15 and later',
            'file_types' => ['dmg', 'zip'],
            'icon' => 'fab fa-apple'
        ],
        'linux' => [
            'url' => build_url(array('page' => 'downloads', 'type' => 'misc', 'id' => 'openlink-linux'), get_module_zone('downloads')),
            'direct_url' => $base_url . '/uploads/website_specific/apps/OpenLink/clients/linux/',
            'title' => 'OpenLink for Linux',
            'description' => 'AppImage compatible with most Linux distributions',
            'file_types' => ['AppImage', 'tar.gz'],
            'icon' => 'fab fa-linux'
        ]
    ];
}

/**
 * Get installer type label based on filename
 */
function get_installer_type_label($filename) {
    $filename_lower = strtolower($filename);

    // Windows
    if (strpos($filename_lower, 'setup') !== false && strpos($filename_lower, '.exe') !== false) {
        return ['type' => 'Installer', 'description' => 'Installs to Program Files with shortcuts'];
    }
    if (strpos($filename_lower, '.exe') !== false && strpos($filename_lower, 'setup') === false) {
        return ['type' => 'Portable', 'description' => 'No installation needed, run from any folder'];
    }

    // macOS
    if (strpos($filename_lower, '-arm64.dmg') !== false) {
        return ['type' => 'Apple Silicon', 'description' => 'For M1/M2/M3/M4 Macs'];
    }
    if (strpos($filename_lower, '.dmg') !== false) {
        return ['type' => 'Intel', 'description' => 'For Intel-based Macs'];
    }
    if (strpos($filename_lower, '-mac.zip') !== false) {
        return ['type' => 'Portable', 'description' => 'ZIP archive, no installation'];
    }

    // Linux
    if (strpos($filename_lower, '.appimage') !== false) {
        return ['type' => 'AppImage', 'description' => 'Universal, runs on most distributions'];
    }
    if (strpos($filename_lower, '.deb') !== false) {
        return ['type' => 'Debian Package', 'description' => 'For Ubuntu, Debian, and derivatives'];
    }
    if (strpos($filename_lower, '.tar.gz') !== false) {
        return ['type' => 'Archive', 'description' => 'Extract and run manually'];
    }

    return ['type' => '', 'description' => ''];
}

/**
 * Get available download files for a platform
 */
function get_platform_files($platform) {
    $upload_path = dirname(dirname(dirname(__FILE__))) . '/uploads/website_specific/apps/OpenLink/clients/' . $platform;

    if (!is_dir($upload_path)) {
        return [];
    }

    $files = [];
    $allowed_extensions = ['exe', 'dmg', 'AppImage', 'zip', 'tar.gz'];

    foreach (scandir($upload_path) as $file) {
        if ($file === '.' || $file === '..') continue;

        $file_path = $upload_path . '/' . $file;
        if (!is_file($file_path)) continue;

        $extension = pathinfo($file, PATHINFO_EXTENSION);
        if (pathinfo($file, PATHINFO_EXTENSION) === 'gz' && substr($file, -7) === '.tar.gz') {
            $extension = 'tar.gz';
        }

        if (!in_array($extension, $allowed_extensions)) continue;

        $type_info = get_installer_type_label($file);

        $files[] = [
            'name' => $file,
            'size' => filesize($file_path),
            'modified' => filemtime($file_path),
            'extension' => $extension,
            'download_url' => get_base_url() . '/uploads/website_specific/apps/OpenLink/clients/' . $platform . '/' . $file,
            'type' => $type_info['type'],
            'type_description' => $type_info['description']
        ];
    }

    // Sort by modification date, newest first
    usort($files, function($a, $b) {
        return $b['modified'] - $a['modified'];
    });

    return $files;
}

/**
 * Format file size
 */
function format_file_size($bytes) {
    if ($bytes >= 1073741824) {
        return round($bytes / 1073741824, 2) . ' GB';
    } elseif ($bytes >= 1048576) {
        return round($bytes / 1048576, 2) . ' MB';
    } elseif ($bytes >= 1024) {
        return round($bytes / 1024, 2) . ' KB';
    } else {
        return $bytes . ' bytes';
    }
}

/**
 * API endpoint for download information
 */
if ($_SERVER['REQUEST_METHOD'] === 'GET' && isset($_GET['action'])) {
    header('Content-Type: application/json');
    
    switch ($_GET['action']) {
        case 'platforms':
            echo json_encode(get_openlink_download_urls());
            break;
            
        case 'files':
            $platform = $_GET['platform'] ?? '';
            if (empty($platform) || !in_array($platform, ['windows', 'mac', 'linux'])) {
                http_response_code(400);
                echo json_encode(['error' => 'Invalid platform']);
                break;
            }
            
            $files = get_platform_files($platform);
            echo json_encode(['platform' => $platform, 'files' => $files]);
            break;
            
        case 'latest':
            $platform = $_GET['platform'] ?? '';
            if (empty($platform) || !in_array($platform, ['windows', 'mac', 'linux'])) {
                http_response_code(400);
                echo json_encode(['error' => 'Invalid platform']);
                break;
            }
            
            $files = get_platform_files($platform);
            if (empty($files)) {
                http_response_code(404);
                echo json_encode(['error' => 'No files available']);
                break;
            }
            
            $latest = $files[0];
            echo json_encode(['platform' => $platform, 'latest' => $latest]);
            break;
            
        default:
            http_response_code(400);
            echo json_encode(['error' => 'Unknown action']);
    }
    exit;
}

/**
 * Handle direct download requests
 */
if ($_SERVER['REQUEST_METHOD'] === 'GET' && isset($_GET['download'])) {
    $platform = $_GET['platform'] ?? '';
    $filename = $_GET['filename'] ?? '';
    
    if (empty($platform) || empty($filename)) {
        http_response_code(400);
        echo 'Invalid download request';
        exit;
    }
    
    if (!in_array($platform, ['windows', 'mac', 'linux'])) {
        http_response_code(400);
        echo 'Invalid platform';
        exit;
    }
    
    $file_path = dirname(dirname(dirname(__FILE__))) . '/uploads/website_specific/apps/OpenLink/clients/' . $platform . '/' . $filename;
    
    if (!file_exists($file_path) || !is_file($file_path)) {
        http_response_code(404);
        echo 'File not found';
        exit;
    }
    
    // Security check - ensure file is in the correct directory
    if (strpos(realpath($file_path), realpath(dirname(dirname(dirname(__FILE__))) . '/uploads/website_specific/apps/OpenLink/clients/')) !== 0) {
        http_response_code(403);
        echo 'Access denied';
        exit;
    }
    
    // Serve the file
    $mime_types = [
        'exe' => 'application/octet-stream',
        'dmg' => 'application/x-apple-diskimage',
        'zip' => 'application/zip',
        'AppImage' => 'application/x-executable',
        'gz' => 'application/gzip'
    ];
    
    $extension = pathinfo($filename, PATHINFO_EXTENSION);
    $mime_type = $mime_types[$extension] ?? 'application/octet-stream';
    
    header('Content-Type: ' . $mime_type);
    header('Content-Disposition: attachment; filename="' . basename($filename) . '"');
    header('Content-Length: ' . filesize($file_path));
    header('Cache-Control: no-cache, must-revalidate');
    header('Expires: 0');
    
    readfile($file_path);
    exit;
}

// Default: Return download information as HTML
?>
<!DOCTYPE html>
<html>
<head>
    <title>OpenLink Downloads</title>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        body { font-family: Arial, sans-serif; margin: 40px; }
        .platform { margin: 20px 0; padding: 20px; border: 1px solid #ddd; border-radius: 8px; }
        .file-list { margin-top: 10px; }
        .file-item {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 12px 8px;
            border-bottom: 1px solid #eee;
            gap: 10px;
        }
        .file-type {
            display: inline-block;
            background: #e8f4fc;
            color: #007cba;
            padding: 2px 8px;
            border-radius: 4px;
            font-size: 12px;
            font-weight: bold;
            margin-right: 8px;
        }
        .type-desc {
            color: #666;
            font-size: 13px;
        }
        .download-btn {
            background: #007cba;
            color: white;
            padding: 8px 16px;
            text-decoration: none;
            border-radius: 4px;
            white-space: nowrap;
        }
        .download-btn:hover { background: #005a87; }
    </style>
</head>
<body>
    <h1>OpenLink Downloads</h1>
    <p>Choose your platform to download the OpenLink desktop application:</p>

    <?php
    $platforms = get_openlink_download_urls();
    foreach ($platforms as $platform_key => $platform_info) {
        $files = get_platform_files($platform_key);
        ?>
        <div class="platform">
            <h2><i class="<?php echo $platform_info['icon']; ?>"></i> <?php echo $platform_info['title']; ?></h2>
            <p><?php echo $platform_info['description']; ?></p>
            
            <?php if (!empty($files)): ?>
                <div class="file-list">
                    <h3>Available Downloads:</h3>
                    <?php foreach ($files as $file): ?>
                        <div class="file-item">
                            <span>
                                <?php if (!empty($file['type'])): ?>
                                    <span class="file-type"><?php echo htmlspecialchars($file['type']); ?></span>
                                <?php endif; ?>
                                <strong><?php echo htmlspecialchars($file['name']); ?></strong>
                                (<?php echo format_file_size($file['size']); ?>)
                                <?php if (!empty($file['type_description'])): ?>
                                    <span class="type-desc">- <?php echo htmlspecialchars($file['type_description']); ?></span>
                                <?php endif; ?>
                            </span>
                            <a href="?download=1&platform=<?php echo $platform_key; ?>&filename=<?php echo urlencode($file['name']); ?>"
                               class="download-btn">Download</a>
                        </div>
                    <?php endforeach; ?>
                </div>
            <?php else: ?>
                <p><em>No downloads available for this platform yet.</em></p>
            <?php endif; ?>
        </div>
        <?php
    }
    ?>

    <hr>
    <p><small>
        API Endpoints:<br>
        - <code>?action=platforms</code> - Get all platform information<br>
        - <code>?action=files&platform=windows</code> - Get files for specific platform<br>
        - <code>?action=latest&platform=windows</code> - Get latest file for platform
    </small></p>
</body>
</html>