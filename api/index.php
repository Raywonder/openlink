<?php
/**
 * OpenLink API Proxy for Composr v10
 * 
 * This proxy forwards requests to the Node.js OpenLink backend
 * and handles CORS, authentication, and error responses.
 */

// Security headers
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Authorization, X-Requested-With');

// Handle preflight requests
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit();
}

// Configuration
$OPENLINK_BACKEND = 'http://localhost:3002/api';
$ALLOWED_ENDPOINTS = [
    '/auth/login',
    '/auth/register', 
    '/auth/profile',
    '/links',
    '/relay',
    '/downloads'
];

// Get request information
$method = $_SERVER['REQUEST_METHOD'];
$requestUri = $_SERVER['REQUEST_URI'];
$pathInfo = $_SERVER['PATH_INFO'] ?? '';

// Extract the endpoint from the path
$endpoint = '';
if (strpos($requestUri, '/apps/OpenLink/api/') !== false) {
    $parts = explode('/apps/OpenLink/api/', $requestUri, 2);
    if (isset($parts[1])) {
        $endpoint = '/' . trim($parts[1], '/');
        // Remove query string
        if (strpos($endpoint, '?') !== false) {
            $endpoint = substr($endpoint, 0, strpos($endpoint, '?'));
        }
    }
}

// Validate endpoint
$isAllowed = false;
foreach ($ALLOWED_ENDPOINTS as $allowed) {
    if (strpos($endpoint, $allowed) === 0) {
        $isAllowed = true;
        break;
    }
}

if (!$isAllowed) {
    http_response_code(403);
    echo json_encode(['error' => 'Endpoint not allowed']);
    exit();
}

// Build target URL
$targetUrl = $OPENLINK_BACKEND . $endpoint;
if (!empty($_SERVER['QUERY_STRING'])) {
    $targetUrl .= '?' . $_SERVER['QUERY_STRING'];
}

// Get request body
$requestBody = file_get_contents('php://input');

// Prepare headers for backend request
$headers = [
    'Content-Type: application/json',
    'Accept: application/json',
    'User-Agent: OpenLink-Composr-Proxy/1.0'
];

// Forward authorization header
if (isset($_SERVER['HTTP_AUTHORIZATION'])) {
    $headers[] = 'Authorization: ' . $_SERVER['HTTP_AUTHORIZATION'];
}

// Add Composr user context if available
if (function_exists('get_member') && is_logged_in()) {
    $member = get_member();
    $headers[] = 'X-Composr-User: ' . $member;
}

// Create context for the request
$context = [
    'http' => [
        'method' => $method,
        'header' => implode("\r\n", $headers),
        'content' => $requestBody,
        'timeout' => 30,
        'ignore_errors' => true
    ]
];

// Make the request to the backend
$stream = stream_context_create($context);
$response = @file_get_contents($targetUrl, false, $stream);

// Handle connection errors
if ($response === false) {
    http_response_code(503);
    echo json_encode([
        'error' => 'Backend service unavailable',
        'message' => 'The OpenLink service is currently unavailable. Please try again later.'
    ]);
    exit();
}

// Get response headers
$responseHeaders = $http_response_header ?? [];
$statusCode = 200;

// Extract status code from headers
foreach ($responseHeaders as $header) {
    if (preg_match('/^HTTP\/\d\.\d (\d{3})/', $header, $matches)) {
        $statusCode = (int)$matches[1];
        break;
    }
}

// Set the response status code
http_response_code($statusCode);

// Forward the response
echo $response;

/**
 * Helper function to check if user is logged in (Composr function)
 */
function is_logged_in() {
    if (function_exists('is_guest')) {
        return !is_guest();
    }
    return false;
}

/**
 * Get current member ID (Composr function)  
 */
function get_member() {
    if (function_exists('get_member')) {
        return get_member();
    }
    return null;
}

/**
 * Log API requests for debugging (optional)
 */
function log_api_request($method, $endpoint, $statusCode) {
    $logFile = dirname(__FILE__) . '/api.log';
    $timestamp = date('Y-m-d H:i:s');
    $logEntry = "[$timestamp] $method $endpoint - Status: $statusCode\n";
    
    // Only log in development mode
    if (defined('DEVELOPMENT_MODE') && DEVELOPMENT_MODE) {
        file_put_contents($logFile, $logEntry, FILE_APPEND | LOCK_EX);
    }
}

// Optional: Log the request
if (isset($endpoint) && isset($statusCode)) {
    log_api_request($method, $endpoint, $statusCode);
}
?>