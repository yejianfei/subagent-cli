const fs = require('fs');
const os = require('os');
const path = require('path');
const webpack = require('webpack');
const CopyWebpackPlugin = require('copy-webpack-plugin');

// node-pty utils.js shim — replaces the original dynamic require() with
// __non_webpack_require__ that loads native binaries from dist/lib/ at runtime
const NODE_PTY_SHIM = `
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadNativeModule = exports.assign = void 0;
function assign(target) {
  var sources = [].slice.call(arguments, 1);
  sources.forEach(function (s) { Object.keys(s).forEach(function (k) { target[k] = s[k]; }); });
  return target;
}
exports.assign = assign;
function loadNativeModule(name) {
  var dir = __dirname + '/lib/' + process.platform + '-' + process.arch;
  return { dir: dir, module: __non_webpack_require__(dir + '/' + name + '.node') };
}
exports.loadNativeModule = loadNativeModule;
`;
const shimPath = path.join(os.tmpdir(), 'node_pty_utils_shim.js');
fs.writeFileSync(shimPath, NODE_PTY_SHIM);

module.exports = {
  entry: {
    'cli': './src/cli.ts',
    'app': './src/app.ts',
  },
  target: 'node',
  mode: 'production',
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      },
    ],
  },
  resolve: {
    extensions: ['.ts', '.js', '.node'],
    extensionAlias: {
      '.js': ['.ts', '.js'],
    },
  },
  output: {
    filename: '[name].js',
    path: path.resolve(__dirname, 'dist'),
    clean: true,
    library: { type: 'commonjs2' },
  },
  optimization: {
    minimize: false,
  },
  node: {
    __dirname: false,
    __filename: false,
  },
  externals: {
    'bufferutil': 'commonjs bufferutil',
    'utf-8-validate': 'commonjs utf-8-validate',
  },
  plugins: [
    new webpack.BannerPlugin({
      banner: '#!/usr/bin/env node',
      raw: true,
      entryOnly: true,
      test: /cli\.js$/,
    }),
    // Replace node-pty's utils.js with shim (loads .node from dist/lib/ via __non_webpack_require__)
    new webpack.NormalModuleReplacementPlugin(
      /node-pty[/\\]lib[/\\]utils\.js$/,
      shimPath
    ),
    // Copy native binaries (pty.node + spawn-helper) to dist/lib/
    new CopyWebpackPlugin({
      patterns: [
        {
          from: 'node_modules/node-pty/prebuilds',
          to: 'lib',
          globOptions: { ignore: ['**/win32-*/**'] },
        },
      ],
    }),
  ],
};
