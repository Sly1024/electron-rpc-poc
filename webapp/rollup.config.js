import typescript from 'rollup-plugin-typescript2';
import resolve from 'rollup-plugin-node-resolve';
import sourcemaps from 'rollup-plugin-sourcemaps';

export default {
    input: 'webapp.ts',
    output: {
        file: '../dist/webapp/bundle.js',
        format: 'umd',
        sourcemap: true,
        name: 'webapp'
    },
    plugins: [
        resolve(),
        sourcemaps(),
        typescript()
    ]
}