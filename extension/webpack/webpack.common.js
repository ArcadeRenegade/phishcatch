// Copyright 2021 Palantir Technologies
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

const path = require('path');
const webpack = require('webpack');
const CopyPlugin = require('copy-webpack-plugin');
const srcDir = '../src/';

module.exports = {
    entry: {
        popup: path.join(__dirname, srcDir + 'popup.tsx'),
        // Classic (non-module) service worker. onnxruntime-web is NOT loaded here:
        // MV3 service workers forbid the dynamic import() ORT uses to load its wasm
        // glue, so inference runs in an offscreen document instead (see offscreen.ts
        // and lib/inferenceRPC.ts).
        background: path.join(__dirname, srcDir + 'background.ts'),
        content: path.join(__dirname, srcDir + 'content.ts'),
        // Offscreen document: a real DOM context (extension origin) where dynamic
        // import()/WASM are permitted. Owns the onnxruntime-web session.
        offscreen: path.join(__dirname, srcDir + 'offscreen.ts'),
    },
    output: {
        path: path.join(__dirname, '../dist/js'),
        filename: '[name].js',
        hashFunction: 'xxhash64',
        // Explicit publicPath disables webpack's "automatic publicPath" runtime,
        // which throws "Automatic publicPath is not supported" in the content-script
        // world (no detectable script URL). The emitted wasm asset URL is unused at
        // runtime because ORT loads the binary via ort.env.wasm.wasmPaths instead.
        publicPath: '',
    },
    optimization: {
        splitChunks: {
            name: 'vendor',
            // The MV3 service worker must be a single self-contained file, so the
            // background entry is excluded from the shared vendor chunk. The
            // offscreen entry is also excluded so the heavy onnxruntime-web bundle
            // stays in offscreen.js and never leaks into vendor.js (which content
            // scripts load into every frame). popup and content share vendor.js.
            chunks(chunk) {
                return chunk.name !== 'background' && chunk.name !== 'offscreen';
            },
        },
    },
    module: {
        rules: [
            {
                test: /\.tsx?$/,
                use: 'ts-loader',
                exclude: /node_modules/,
            },
            {
                // The ORT bundle references its wasm via `new URL(..., import.meta.url)`.
                // Emit that single asset straight into dist/ml with the fixed name ORT's
                // wasmPaths expects, instead of a hashed copy under dist/js.
                test: /ort-wasm-simd-threaded\.wasm$/,
                type: 'asset/resource',
                generator: {
                    filename: '../ml/[name][ext]',
                },
            },
        ],
    },
    resolve: {
        extensions: ['.ts', '.tsx', '.js'],
        alias: {
            // Use the lean wasm-only ORT build (inlined loader glue, single
            // ort-wasm-simd-threaded.wasm) instead of the default JSEP/WebGPU
            // build, which would pull a 26MB wasm and a fragile dynamic .mjs import.
            'onnxruntime-web$': path.join(__dirname, '../node_modules/onnxruntime-web/dist/ort.wasm.bundle.min.mjs'),
        },
        fallback: {
            "buffer": require.resolve('buffer/'),
            'util': require.resolve('util/')
        }
    },
    plugins: [
        new webpack.ProvidePlugin({
            process: 'process/browser',
            Buffer: ['buffer', 'Buffer'],
        }),
        new CopyPlugin({
            // patterns: [{ from: './public/', to: './' }],
            patterns: [
                { from: '.', to: '../', context: 'public' },
                // ML artifacts produced by the Python pipeline (pipeline/export -> dist/ml).
                // The ORT wasm binary is emitted to dist/ml by the asset rule above.
                { from: path.join(__dirname, '../../pipeline/export'), to: '../ml' },
                // ORT loads its emscripten loader glue (.mjs) at runtime via a dynamic
                // import from wasmPaths, so it must sit next to the wasm in dist/ml.
                {
                    from: path.join(__dirname, '../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs'),
                    to: '../ml/ort-wasm-simd-threaded.mjs',
                },
            ],
            options: {},
        }),
    ],
};
