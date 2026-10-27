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

import * as monaco from 'monaco-editor';

// Word lists follow the keyword tables of omc (seed/omc/omc.om in aien-dev/omega-mv).
function definition(): monaco.languages.IMonarchLanguage {
    return {
        keywords: [
            'fn',
            'to',
            'end',
            'if',
            'else',
            'while',
            'bound',
            'for',
            'break',
            'continue',
            'ret',
            'own',
            'global',
            'text',
            'const',
            'struct',
            'new',
            'put',
            'free',
            'exit',
            'trap',
            'view',
            'edit',
            'true',
            'false',
            'unroll',
            'inline',
            'fresh',
            'abstract',
            'seal',
            'open',
            'holds',
            'layout',
            'field',
            'at',
            'little',
            'big',
            'part',
            'out',
            'export',
            'ops',
            'requires',
            'ensures',
            'invariant',
            'result',
            'om2',
            'ir',
        ],

        types: [
            'void',
            'bool',
            'byte',
            'uchar',
            'u8',
            'i8',
            'ushort',
            'u16',
            'short',
            'i16',
            'uint',
            'u32',
            'int',
            'i32',
            'ulong',
            'u64',
            'long',
            'i64',
            'f32',
            'f64',
        ],

        operators: [
            'add',
            'sub',
            'mul',
            'div',
            'rem',
            'and',
            'or',
            'xor',
            'shl',
            'shr',
            'rotl',
            'rotr',
            'eq',
            'ne',
            'lt',
            'le',
            'gt',
            'ge',
            'neg',
            'not',
            'get',
            'len',
            'bitcast',
            'fsqrt',
            'fabs',
            'fmin',
            'fmax',
            'sizeof',
            'offsetof',
        ],

        hostwords: [
            'read',
            'write',
            'pread',
            'pwrite',
            'fopen',
            'fclose',
            'fsync',
            'fdsync',
            'fchmod',
            'fseek',
            'ftrunc',
            'fstat',
            'stat',
            'lstat',
            'unlink',
            'makedir',
            'rmdir',
            'renames',
            'link',
            'symlnk',
            'chmod',
            'chown',
            'truncate',
            'faccess',
            'getdnts',
            'cwd',
            'chdir',
            'fchdir',
            'flock',
            'syncfs',
            'memfd',
            'socknew',
            'bind',
            'listen',
            'accept',
            'connect',
            'recv',
            'send',
            'sendmsg',
            'shutdown',
            'sockname',
            'peercred',
            'pollfds',
            'waitio',
            'fork',
            'execprog',
            'waitpid',
            'killpid',
            'pipefds',
            'dupfd',
            'getpid',
            'getppid',
            'getuid',
            'geteuid',
            'getgid',
            'getegid',
            'getsid',
            'setsid',
            'getpgid',
            'setpgid',
            'umask',
            'argcnt',
            'argread',
            'envcnt',
            'envread',
            'sleepns',
            'realns',
            'monons',
            'random',
            'devctl',
            'devcall',
            'uvmctl',
            'mapnew',
            'mapdrop',
            'mapread',
            'mapwrite',
            'mapaddr',
            'mapget',
            'mapset',
            'maphold',
            'mapbind',
        ],

        escapes: /\\[\\"nt]/,

        tokenizer: {
            root: [
                [/[ \t\r\n]+/, 'white'],
                [/\bnote\b.*$/, 'comment'],
                [/"/, 'string', '@string'],
                [/0x[0-9a-f]+\b/, 'number.hex'],
                [/-?\d+\.\d+([eE][-+]?\d+)?(f32|f64)?\b/, 'number.float'],
                [/-?\d+\b/, 'number'],
                [
                    /[a-zA-Z_][a-zA-Z0-9_]*/,
                    {
                        cases: {
                            '@keywords': 'keyword',
                            '@types': 'type',
                            '@operators': 'operator',
                            '@hostwords': 'predefined',
                            '@default': 'identifier',
                        },
                    },
                ],
                [/=/, 'operator'],
                [/[()]/, '@brackets'],
            ],

            string: [
                [/[^\\"]+/, 'string'],
                [/@escapes/, 'string.escape'],
                [/\\./, 'string.escape.invalid'],
                [/"/, 'string', '@pop'],
            ],
        },
    };
}

monaco.languages.register({id: 'omega'});
monaco.languages.setMonarchTokensProvider('omega', definition());
monaco.languages.setLanguageConfiguration('omega', {
    comments: {lineComment: 'note'},
    brackets: [['(', ')']],
    autoClosingPairs: [
        {open: '(', close: ')'},
        {open: '"', close: '"'},
    ],
});
