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

import type {CompilationResult, ExecutionOptionsWithEnv} from '../../types/compilation/compilation.interfaces.js';
import type {BasicExecutionResult, UnprocessedExecResult} from '../../types/execution/execution.interfaces.js';
import type {ParseFiltersAndOutputOptions} from '../../types/features/filters.interfaces.js';
import type {ResultLine} from '../../types/resultline/resultline.interfaces.js';
import {BaseCompiler} from '../base-compiler.js';
import {logger} from '../logger.js';
import * as utils from '../utils.js';

const OMC_DIAGNOSTIC = /^omc: line (\d+): error (\d+)/;

// omc reads the whole program on stdin and writes the executable on stdout, so it runs under a shell that redirects
// both to files: CE captures stdout as text, which would mangle the binary.
const REDIRECT_SCRIPT = 'in=$1; out=$2; shift 2; exec "$@" < "$in" > "$out"';

const EM_AARCH64 = 183;
const PT_LOAD = 1;

export type OmegaImageLayout = {
    loadAddress: bigint;
    entry: bigint;
    end: bigint;
};

/**
 * omc emits a static AArch64 ELF with program headers only and no section table, so `objdump -d` finds nothing to
 * disassemble. This locates the loadable segment holding the entry point so that it can be disassembled as raw code.
 */
export function parseOmegaImage(image: Buffer): OmegaImageLayout | undefined {
    if (image.length < 64 || image.readUInt32BE(0) !== 0x7f454c46) return undefined;
    if (image[4] !== 2 || image[5] !== 1 || image.readUInt16LE(18) !== EM_AARCH64) return undefined;

    const entry = image.readBigUInt64LE(24);
    const phoff = Number(image.readBigUInt64LE(32));
    const phentsize = image.readUInt16LE(54);
    const phnum = image.readUInt16LE(56);
    for (let i = 0; i < phnum; i++) {
        const header = phoff + i * phentsize;
        if (header + 56 > image.length) break;
        if (image.readUInt32LE(header) !== PT_LOAD) continue;
        const offset = image.readBigUInt64LE(header + 8);
        const vaddr = image.readBigUInt64LE(header + 16);
        const filesz = image.readBigUInt64LE(header + 32);
        if (entry >= vaddr && entry < vaddr + filesz) {
            return {loadAddress: vaddr - offset, entry, end: vaddr + filesz};
        }
    }
    return undefined;
}

/** omc reports a refused program as `omc: line N: error K` on stderr and exits with K. */
export function parseOmcDiagnostics(text: string, inputFilename?: string): ResultLine[] {
    return utils.parseOutput(text, inputFilename).map(line => {
        const match = line.text.match(OMC_DIAGNOSTIC);
        const lineNumber = match ? Number.parseInt(match[1], 10) : 0;
        if (lineNumber > 0) {
            line.tag = {
                file: inputFilename ? path.basename(inputFilename) : undefined,
                line: lineNumber,
                column: 0,
                text: line.text,
                severity: 3,
            };
        }
        return line;
    });
}

export class OmegaCompiler extends BaseCompiler {
    static get key() {
        return 'omega';
    }

    override optionsForFilter(filters: ParseFiltersAndOutputOptions): string[] {
        filters.binary = true;
        return [];
    }

    override getOutputFilename(dirPath: string, outputFilebase: string): string {
        return path.join(dirPath, outputFilebase);
    }

    override getSharedLibraryPathsAsArguments() {
        return [];
    }

    override async getVersion() {
        if (this.compiler.explicitVersion) return super.getVersion();
        try {
            const digest = crypto
                .createHash('sha256')
                .update(await fs.readFile(this.compiler.exe))
                .digest('hex');
            return {stdout: `omc sha256:${digest}`, stderr: '', code: 0};
        } catch (err) {
            logger.error(`Unable to identify omc at '${this.compiler.exe}' - ${err}`);
            return null;
        }
    }

    override async runCompiler(
        compiler: string,
        options: string[],
        inputFilename: string,
        execOptions: ExecutionOptionsWithEnv,
    ): Promise<CompilationResult> {
        if (!execOptions) execOptions = this.getDefaultExecOptions();
        const dirPath = path.dirname(inputFilename);
        if (!execOptions.customCwd) execOptions.customCwd = dirPath;

        const outputFilename = this.getOutputFilename(dirPath, this.outputFilebase);
        const command = execOptions.wrapper ? [execOptions.wrapper, compiler] : [compiler];
        delete execOptions.wrapper;

        const result = await this.exec(
            '/bin/sh',
            ['-c', REDIRECT_SCRIPT, 'omc', inputFilename, outputFilename, ...command],
            execOptions,
        );
        if (result.code === 0) {
            await fs.chmod(outputFilename, 0o755);
        } else {
            // A refused program can leave partial code on stdout; it must never be disassembled or run.
            await fs.rm(outputFilename, {force: true});
        }
        return this.transformToCompilationResult(result, inputFilename);
    }

    protected override processExecutionResult(
        input: UnprocessedExecResult,
        inputFilename?: string,
    ): BasicExecutionResult {
        return {
            ...input,
            stdout: utils.parseOutput(input.stdout, inputFilename),
            stderr: parseOmcDiagnostics(input.stderr, inputFilename),
        };
    }

    override async objdump(
        outputFilename: string,
        result: any,
        maxSize: number,
        intelAsm: boolean,
        demangle: boolean,
        staticReloc: boolean | undefined,
        dynamicReloc: boolean,
        filters: ParseFiltersAndOutputOptions,
    ) {
        let image: Buffer;
        try {
            image = await fs.readFile(outputFilename);
        } catch {
            result.asm = '<No output file ' + outputFilename + '>';
            return result;
        }

        const layout = parseOmegaImage(image);
        if (!layout) {
            result.asm = '<omc output is not an AArch64 ELF executable>';
            return result;
        }

        const objdumperInfo = this.getObjdumperForResult(result);
        if (!objdumperInfo) {
            result.asm = '<No objdumper configured>';
            return result;
        }

        const args = [
            '-D',
            '-b',
            'binary',
            '-m',
            'aarch64',
            `--adjust-vma=0x${layout.loadAddress.toString(16)}`,
            `--start-address=0x${layout.entry.toString(16)}`,
            `--stop-address=0x${layout.end.toString(16)}`,
            ...(this.compiler.objdumperArgs ?? []),
            outputFilename,
        ];
        const objResult = await this.exec(objdumperInfo.exe, args, {
            maxOutput: maxSize,
            customCwd: (result.dirPath as string) || path.dirname(outputFilename),
        });
        if (objResult.code === 0) {
            result.objdumpTime = objResult.execTime.toString();
            result.asm = this.postProcessObjdumpOutput(objResult.stdout);
        } else {
            logger.error(`Error executing objdump ${objdumperInfo.exe}`, objResult);
            result.asm = `<No output: objdump returned ${objResult.code}>`;
        }
        return result;
    }
}
