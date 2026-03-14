/**
 * OpenLink - macOS Notarization Script
 *
 * This script runs after signing to notarize the app with Apple.
 * Requires environment variables:
 *   - APPLE_ID: Your Apple ID email
 *   - APPLE_APP_SPECIFIC_PASSWORD: App-specific password from appleid.apple.com
 *   - APPLE_TEAM_ID: Your Apple Developer Team ID
 *
 * To enable notarization, set these environment variables and set
 * mac.notarize to true in package.json build config.
 */

const { notarize } = require('@electron/notarize');
const fs = require('fs');
const path = require('path');

function loadEnvFileIfPresent() {
    const envPath = path.resolve(__dirname, '..', '.env');
    if (!fs.existsSync(envPath)) {
        return;
    }

    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) {
            continue;
        }

        const separatorIndex = line.indexOf('=');
        if (separatorIndex === -1) {
            continue;
        }

        const key = line.slice(0, separatorIndex).trim();
        if (!key || process.env[key]) {
            continue;
        }

        let value = line.slice(separatorIndex + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }

        process.env[key] = value;
    }
}

exports.default = async function notarizing(context) {
    const { electronPlatformName, appOutDir } = context;

    loadEnvFileIfPresent();

    // Only notarize macOS builds
    if (electronPlatformName !== 'darwin') {
        console.log('Skipping notarization: Not a macOS build');
        return;
    }

    // Check if notarization is enabled in config
    const pkg = require('../package.json');
    if (pkg.build?.mac?.notarize === false) {
        console.log('Skipping notarization: Disabled in config');
        return;
    }

    // Check for required environment variables
    const appleId = process.env.APPLE_ID;
    const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
    const teamId = process.env.APPLE_TEAM_ID;

    if (!appleId || !appleIdPassword || !teamId) {
        console.log('Skipping notarization: Missing Apple credentials');
        console.log('Set APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, and APPLE_TEAM_ID environment variables');
        return;
    }

    const appName = context.packager.appInfo.productFilename;
    const appPath = path.join(appOutDir, `${appName}.app`);

    console.log(`Notarizing ${appPath}...`);

    try {
        await notarize({
            appPath,
            appleId,
            appleIdPassword,
            teamId
        });
        console.log('Notarization complete!');
    } catch (error) {
        console.error('Notarization failed:', error);
        throw error;
    }
};
