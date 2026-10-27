// Copyright (c) 2026, Compiler Explorer Authors
// All rights reserved.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are met:
//
//     * Redistributions of source code must retain the above copyright notice,
//       this list of conditions and the following disclaimer.
//     * Redistributions in binary form must reproduce the above copyright
//       notice, this list of conditions and the following disclaimer in the
//       documentation and/or other materials provided with the distribution.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
// AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
// IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
// ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
// LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
// CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
// SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
// INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
// CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
// ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
// POSSIBILITY OF SUCH DAMAGE.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import {beforeAll, describe, expect, it, vi} from 'vitest';

import {CompilationEnvironment} from '../lib/compilation-env.js';
import {OmegaCompiler, parseOmcDiagnostics, parseOmegaImage} from '../lib/compilers/omega.js';
import {AsmParser} from '../lib/parsers/asm-parser.js';
import type {UnprocessedExecResult} from '../types/execution/execution.interfaces.js';
import {LanguageKey} from '../types/languages.interfaces.js';
import {
    makeCompilationEnvironment,
    makeFakeCompilerInfo,
    makeFakeParseFiltersAndOutputOptions,
    newTempDir,
} from './utils.js';

const languages = {
    omega: {id: 'omega' as LanguageKey, extensions: ['.om']},
};

/** The header layout omc emits: an ELF header, then two program headers and no section table. */
function makeOmegaImage(codeBytes: number, machine = 183) {
    const image = Buffer.alloc(0xb0 + codeBytes);
    image.writeUInt32BE(0x7f454c46, 0);
    image[4] = 2;
    image[5] = 1;
    image[6] = 1;
    image.writeUInt16LE(2, 16);
    image.writeUInt16LE(machine, 18);
    image.writeBigUInt64LE(0x4000b0n, 24);
    image.writeBigUInt64LE(64n, 32);
    image.writeUInt16LE(56, 54);
    image.writeUInt16LE(2, 56);
    // text: R+X, mapped from offset 0
    image.writeUInt32LE(1, 64);
    image.writeUInt32LE(5, 68);
    image.writeBigUInt64LE(0x400000n, 64 + 16);
    image.writeBigUInt64LE(BigInt(image.length), 64 + 32);
    // globals: R+W, nothing from the file
    image.writeUInt32LE(1, 120);
    image.writeUInt32LE(6, 124);
    image.writeBigUInt64LE(0x10000000n, 120 + 16);
    return image;
}

const execResult: UnprocessedExecResult = {
    code: 0,
    okToCache: true,
    filenameTransform: (x: string) => x,
    stdout: '',
    stderr: '',
    execTime: 1,
    timedOut: false,
    truncated: false,
};

describe('Omega', () => {
    let ce: CompilationEnvironment;

    beforeAll(() => {
        ce = makeCompilationEnvironment({languages});
    });

    function makeCompiler(info: Record<string, any> = {}) {
        return new OmegaCompiler(
            makeFakeCompilerInfo({exe: '/opt/omega/seed/out/omc', lang: languages.omega.id, ...info}),
            ce,
        );
    }

    it('always asks for the binary view, as omc only emits executables', () => {
        const filters = makeFakeParseFiltersAndOutputOptions({});
        expect(makeCompiler().optionsForFilter(filters)).toEqual([]);
        expect(filters.binary).toBe(true);
    });

    it('uses one extensionless file as both the output and the executable', () => {
        const compiler = makeCompiler();
        expect(compiler.getOutputFilename('/tmp/dir', 'output')).toBe(path.join('/tmp/dir', 'output'));
        expect(compiler.getExecutableFilename('/tmp/dir', 'output')).toBe(path.join('/tmp/dir', 'output'));
    });

    describe('parseOmegaImage', () => {
        it('finds the loadable segment that holds the entry point', () => {
            expect(parseOmegaImage(makeOmegaImage(0x264))).toEqual({
                loadAddress: 0x400000n,
                entry: 0x4000b0n,
                end: 0x400314n,
            });
        });

        it('rejects files that are not AArch64 ELF executables', () => {
            expect(parseOmegaImage(Buffer.from('omc: line 2: error 3\n'))).toBeUndefined();
            expect(parseOmegaImage(makeOmegaImage(16, 62))).toBeUndefined();
            expect(parseOmegaImage(makeOmegaImage(16).subarray(0, 100))).toBeUndefined();
        });
    });

    describe('parseOmcDiagnostics', () => {
        it('tags omc errors with the line they name', () => {
            expect(parseOmcDiagnostics('omc: line 2: error 3\n', '/tmp/dir/example.om')).toEqual([
                {
                    text: 'omc: line 2: error 3',
                    tag: {file: 'example.om', line: 2, column: 0, text: 'omc: line 2: error 3', severity: 3},
                },
            ]);
        });

        it('leaves other output untagged', () => {
            expect(parseOmcDiagnostics('omc: line 0: error 40\nsomething else\n')).toEqual([
                {text: 'omc: line 0: error 40'},
                {text: 'something else'},
            ]);
        });
    });

    describe('runCompiler', () => {
        it('feeds the source on stdin and writes stdout to the executable, inside the configured wrapper', async () => {
            const compiler = makeCompiler();
            const dir = newTempDir();
            const input = path.join(dir, 'example.om');
            const output = path.join(dir, 'output');
            const exec = vi.spyOn(compiler, 'exec').mockImplementation(async () => {
                await fs.writeFile(output, makeOmegaImage(16));
                return execResult;
            });

            const result = await compiler.runCompiler('/opt/omega/seed/out/omc', [input], input, {
                env: {},
                wrapper: '/usr/bin/qemu-aarch64-static',
            });

            expect(result.code).toBe(0);
            const [command, args, options] = exec.mock.calls[0];
            expect(command).toBe('/bin/sh');
            expect(args.slice(2)).toEqual([
                'omc',
                input,
                output,
                '/usr/bin/qemu-aarch64-static',
                '/opt/omega/seed/out/omc',
            ]);
            expect(options.wrapper).toBeUndefined();
            expect(options.customCwd).toBe(dir);
            expect((await fs.stat(output)).mode & 0o111).toBe(0o111);
        });

        it('discards whatever a refused compile wrote, so it is never disassembled or run', async () => {
            const compiler = makeCompiler();
            const dir = newTempDir();
            const input = path.join(dir, 'example.om');
            const output = path.join(dir, 'output');
            vi.spyOn(compiler, 'exec').mockImplementation(async () => {
                await fs.writeFile(output, 'partial');
                return {...execResult, code: 3, stderr: 'omc: line 2: error 3\n'};
            });

            const result = await compiler.runCompiler('/opt/omega/seed/out/omc', [input], input, {env: {}});

            expect(result.code).toBe(3);
            expect(result.stderr[0].tag?.line).toBe(2);
            await expect(fs.access(output)).rejects.toThrow();
        });
    });

    describe('objdump', () => {
        it('disassembles the code segment as raw AArch64, since omc writes no section table', async () => {
            const compiler = makeCompiler({objdumper: 'objdump', objdumperType: 'default'});
            const dir = newTempDir();
            const output = path.join(dir, 'output');
            await fs.writeFile(output, makeOmegaImage(0x264));
            const exec = vi
                .spyOn(compiler, 'exec')
                .mockResolvedValue({...execResult, stdout: '  4000b0:\t14000093 \tb\t0x4002fc\n'});

            const result = await compiler.objdump(output, {dirPath: dir}, 1024, false, false, false, false, {});

            expect(exec).toHaveBeenCalledWith(
                'objdump',
                [
                    '-D',
                    '-b',
                    'binary',
                    '-m',
                    'aarch64',
                    '--adjust-vma=0x400000',
                    '--start-address=0x4000b0',
                    '--stop-address=0x400314',
                    output,
                ],
                {maxOutput: 1024, customCwd: dir},
            );
            expect(result.asm).toContain('b\t0x4002fc');
        });

        it('parses the objdump listing as binary output', () => {
            const listing = [
                '',
                'output:     file format binary',
                '',
                '',
                'Disassembly of section .data:',
                '',
                '00000000004000b0 <.data+0xb0>:',
                '  4000b0:\t14000093 \tb\t0x4002fc',
                '  4000b4:\t9b007c00 \tmul\tx0, x0, x0',
                '  4000b8:\td65f03c0 \tret',
            ].join('\n');
            const parsed = new AsmParser().process(listing, makeFakeParseFiltersAndOutputOptions({binary: true}));
            expect(parsed.asm.map(line => line.text.trim())).toEqual([
                '.data+0xb0:',
                'b\t0x4002fc',
                'mul\tx0, x0, x0',
                'ret',
            ]);
            expect(parsed.asm.find(line => line.text.includes('mul'))?.address).toBe(0x4000b4);
        });

        it('refuses to disassemble output that is not an omc executable', async () => {
            const compiler = makeCompiler({objdumper: 'objdump', objdumperType: 'default'});
            const dir = newTempDir();
            const output = path.join(dir, 'output');
            await fs.writeFile(output, 'not an executable');
            const exec = vi.spyOn(compiler, 'exec');

            const result = await compiler.objdump(output, {dirPath: dir}, 1024, false, false, false, false, {});

            expect(exec).not.toHaveBeenCalled();
            expect(result.asm).toBe('<omc output is not an AArch64 ELF executable>');
        });
    });

    describe('getVersion', () => {
        it('identifies omc by the sha256 of its executable, as omc has no version flag', async () => {
            const dir = newTempDir();
            const exe = path.join(dir, 'omc');
            await fs.writeFile(exe, 'omc stand-in');
            const digest = crypto.createHash('sha256').update('omc stand-in').digest('hex');

            expect(await makeCompiler({exe}).getVersion()).toEqual({
                stdout: `omc sha256:${digest}`,
                stderr: '',
                code: 0,
            });
        });

        it('prefers an explicit version', async () => {
            const version = await makeCompiler({explicitVersion: 'omc e5b32567'}).getVersion();
            expect(version?.stdout).toBe('omc e5b32567');
        });
    });
});
