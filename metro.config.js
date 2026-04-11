// metro.config.js
// Tells Metro bundler to treat .glb files as binary assets
// so they get bundled into the APK and accessible via require()
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Add glb/gltf to asset extensions so Metro bundles them
config.resolver.assetExts.push('glb', 'gltf', 'bin');

module.exports = config;
