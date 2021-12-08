import typescript from 'rollup-plugin-typescript2';
import resolve from 'rollup-plugin-node-resolve';

export default {
    input: 'webapp.ts',
    output: {
        file: '../dist/webapp/bundle.js',
        format: 'umd',
        name: 'webapp'
    },
    plugins: [
        resolve(),
        typescript()
    ]
}