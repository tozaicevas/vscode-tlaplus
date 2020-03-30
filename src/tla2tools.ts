import * as cp from 'child_process';
import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { pathToUri } from './common';
import { JavaVersionParser } from './parsers/javaVersion';

const CFG_JAVA_HOME = 'tlaplus.java.home';
const CFG_JAVA_OPTIONS = 'tlaplus.java.options';
const CFG_TLC_OPTIONS = 'tlaplus.tlc.modelChecker.options';
const CFG_PLUSCAL_OPTIONS = 'tlaplus.pluscal.options';

const VAR_TLC_SPEC_NAME = /\$\{specName\}/g;
const VAR_TLC_MODEL_NAME = /\$\{modelName\}/g;

const NO_ERROR = 0;
const MIN_TLA_ERROR = 10;           // Exit codes not related to tooling start from this number
const LOWEST_JAVA_VERSION = 8;
const DEFAULT_GC_OPTION = '-XX:+UseParallelGC';
const TLA_TOOLS_LIB_NAME = 'tla2tools.jar';
const TLA_TOOLS_LIB_NAME_END_UNIX = '/' + TLA_TOOLS_LIB_NAME;
const TLA_TOOLS_LIB_NAME_END_WIN = '\\' + TLA_TOOLS_LIB_NAME;
const toolsJarPath = path.resolve(__dirname, '../../tools/' + TLA_TOOLS_LIB_NAME);
const javaCmd = 'java' + (process.platform === 'win32' ? '.exe' : '');

let lastUsedJavaHome: string | undefined;
let cachedJavaPath: string | undefined;

enum TlaTool {
    PLUS_CAL = 'pcal.trans',
    SANY = 'tla2sany.SANY',
    TLC = 'tlc2.TLC',
    TEX = 'tla2tex.TLA'
}

export class ToolProcessInfo {
    constructor(
        readonly commandLine: string,
        readonly process: ChildProcess
    ) {}
}

/**
 * Thrown when there's some problem with Java or TLA+ tooling.
 */
export class ToolingError extends Error {
    constructor(message: string) {
        super(message);
    }
}

export class JavaVersion {
    static UNKNOWN_VERSION = '?';

    constructor(
        readonly version: string,
        readonly fullOutput: string[]
    ) {}
}

export async function runPlusCal(tlaFilePath: string): Promise<ToolProcessInfo> {
    const customOptions = getConfigOptions(CFG_PLUSCAL_OPTIONS);
    return runTool(
        TlaTool.PLUS_CAL,
        tlaFilePath,
        buildPlusCalOptions(tlaFilePath, customOptions),
        []
    );
}

export async function runSany(tlaFilePath: string): Promise<ToolProcessInfo> {
    return runTool(
        TlaTool.SANY,
        tlaFilePath,
        [ path.basename(tlaFilePath) ],
        []
    );
}

export async function runTex(tlaFilePath: string): Promise<ToolProcessInfo> {
    return runTool(
        TlaTool.TEX,
        tlaFilePath,
        [ path.basename(tlaFilePath) ],
        []
    );
}

export async function runTlc(tlaFilePath: string, cfgFilePath: string, ignoreDeadlock?: boolean): Promise<ToolProcessInfo> {
    const customOptions = getConfigOptions(CFG_TLC_OPTIONS);
    const customOptionsWithPossibleDeadlock = ( () => {
        if (!ignoreDeadlock)
            return customOptions.filter(x => x === "-deadlock");
        return (customOptions.some(x => x == "-deadlock") ? customOptions : [...customOptions, "-deadlock"]);
    } )();
    return runTool(
        TlaTool.TLC,
        tlaFilePath,
        buildTlcOptions(tlaFilePath, cfgFilePath, customOptionsWithPossibleDeadlock),
        [ /*'-Dtlc2.TLC.ide=vscode'*/ ]
    );
}

async function runTool(
    toolName: string,
    filePath: string,
    toolOptions: string[],
    javaOptions: string[]
): Promise<ToolProcessInfo> {
    const javaPath = await obtainJavaPath();
    const cfgOptions = getConfigOptions(CFG_JAVA_OPTIONS);
    const args = buildJavaOptions(cfgOptions, toolsJarPath).concat(javaOptions);
    args.push(toolName);
    toolOptions.forEach(opt => args.push(opt));
    const proc = spawn(javaPath, args, { cwd: path.dirname(filePath) });
    addReturnCodeHandler(proc, toolName);
    return new ToolProcessInfo(buildCommandLine(javaPath, args), proc);
}

/**
 * Kills the given process.
 */
export function stopProcess(p: cp.ChildProcess) {
    if (!p.killed) {
        p.kill('SIGINT');
    }
}

export function reportBrokenToolchain(err: any) {
    console.log('Toolchain problem: ' + err.message);
    vscode.window.showErrorMessage('Toolchain is broken');
}

async function obtainJavaPath(): Promise<string> {
    const javaHome = vscode.workspace.getConfiguration().get<string>(CFG_JAVA_HOME);
    if (cachedJavaPath && javaHome === lastUsedJavaHome) {
        return cachedJavaPath;
    }
    const javaPath = buildJavaPath();
    cachedJavaPath = javaPath;
    lastUsedJavaHome = javaHome;
    await checkJavaVersion(javaPath);
    return javaPath;
}

/**
 * Builds path to the Java executable based on the configuration.
 */
function buildJavaPath(): string {
    let javaPath = javaCmd;
    const javaHome = vscode.workspace.getConfiguration().get<string>(CFG_JAVA_HOME);
    if (javaHome) {
        const homeUri = pathToUri(javaHome);
        javaPath = homeUri.fsPath + path.sep + 'bin' + path.sep + javaCmd;
        if (!fs.existsSync(javaPath)) {
            throw new ToolingError('Java executable not found. Check the Java Home setting.');
        }
    }
    return javaPath;
}

/**
 * Builds an array of options to pass to Java process when running TLA tools.
 */
export function buildJavaOptions(customOptions: string[], defaultClassPath: string): string[] {
    const opts = customOptions.slice(0);
    mergeClassPathOption(opts, defaultClassPath);
    mergeGCOption(opts, DEFAULT_GC_OPTION);
    return opts;
}

/**
 * Builds an array of options to pass to the TLC tool.
 */
export function buildTlcOptions(tlaFilePath: string, cfgFilePath: string, customOptions: string[]): string[] {
    const custOpts = customOptions.map((opt) => {
        return opt
            .replace(VAR_TLC_SPEC_NAME, path.basename(tlaFilePath, '.tla'))
            .replace(VAR_TLC_MODEL_NAME, path.basename(cfgFilePath, '.cfg'));
    });
    const opts = [path.basename(tlaFilePath), '-tool', '-modelcheck'];
    addValueOrDefault('-coverage', '1', custOpts, opts);
    addValueOrDefault('-config', cfgFilePath, custOpts, opts);
    return opts.concat(custOpts);
}

/**
 * Builds an array of options to pass to the PlusCal tool.
 */
export function buildPlusCalOptions(tlaFilePath: string, customOptions: string[]): string[] {
    const opts = customOptions.slice(0);
    opts.push(path.basename(tlaFilePath));
    return opts;
}

/**
 * Executes java -version and analyzes, if the version is 1.8 or higher.
 */
async function checkJavaVersion(javaPath: string) {
    const proc = spawn(javaPath, ['-version']);
    const parser = new JavaVersionParser(proc.stderr);
    const ver = await parser.readAll();
    if (ver.version === JavaVersion.UNKNOWN_VERSION) {
        ver.fullOutput.forEach(line => console.debug(line));
        throw new ToolingError('Error while obtaining Java version. Check the Java Home setting.');
    }
    let num = ver.version;
    if (num.startsWith('1.')) {
        num = num.substring(2);
    }
    const pIdx = num.indexOf('.');
    if (pIdx > 0 && parseInt(num.substring(0, pIdx), 10) >= LOWEST_JAVA_VERSION) {
        return;
    }
    vscode.window.showWarningMessage(`Unsupported Java version: ${ver.version}`);
}

function addValueOrDefault(option: string, defaultValue: string, args: string[], realArgs: string[]) {
    realArgs.push(option);
    const idx = args.indexOf(option);
    if (idx < 0 || idx === args.length - 1) {
        realArgs.push(defaultValue);
    } else {
        realArgs.push(args[idx + 1]);
        args.splice(idx, 2);
    }
}

/**
 * Adds a handler to the given TLA+ tooling process that captures various system errors.
 */
function addReturnCodeHandler(proc: ChildProcess, toolName?: string) {
    const stderr: string[] = [];
    proc.stderr.on('data', chunk => {
        stderr.push(String(chunk));
    });
    proc.on('close', exitCode => {
        if (exitCode !== NO_ERROR && exitCode < MIN_TLA_ERROR) {
            const details = stderr.join('\n');
            vscode.window.showErrorMessage(`Error running ${toolName} (exit code ${exitCode})\n${details}`);
        }
    });
}

function getConfigOptions(cfgName: string): string[] {
    const optsString = vscode.workspace.getConfiguration().get<string>(cfgName) || '';
    return optsString.split(' ').map(opt => opt.trim()).filter(opt => opt !== '');
}

function buildCommandLine(programName: string, args: string[]): string {
    const line = [ programName ];
    args
        .map(arg => arg.indexOf(' ') >= 0 ? '"' + arg + '"' : arg)
        .forEach(arg => line.push(arg));
    return line.join(' ');
}

/**
 * Adds the default GC option if no custom one is provided.
 */
function mergeGCOption(options: string[], defaultGC: string) {
    const gcOption = options.find(opt => opt.startsWith('-XX:+Use') && opt.endsWith('GC'));
    if (!gcOption) {
        options.push(defaultGC);
    }
}

/**
 * Searches for -cp or -classpath option and merges its value with the default classpath.
 * Custom libraries must be geven precedence over default ones.
 */
function mergeClassPathOption(options: string[], defaultClassPath: string) {
    let cpIdx = -1;
    for (let i = 0; i < options.length; i++) {
        const option = options[i];
        if (option === '-cp' || option === '-classpath') {
            cpIdx = i + 1;
            break;
        }
    }
    if (cpIdx < 0 || cpIdx >= options.length) {
        // No custom classpath provided, use the default one
        options.push('-cp', defaultClassPath);
        return;
    }
    let classPath = options[cpIdx];
    if (containsTlaToolsLib(classPath)) {
        return;
    }
    if (classPath.length > 0) {
        classPath += path.delimiter;
    }
    classPath += defaultClassPath;
    options[cpIdx] = classPath;
}

function containsTlaToolsLib(classPath: string): boolean {
    const paths = classPath.split(path.delimiter);
    for (const p of paths) {
        if (p === TLA_TOOLS_LIB_NAME
            || p.endsWith(TLA_TOOLS_LIB_NAME_END_UNIX)
            || p.endsWith(TLA_TOOLS_LIB_NAME_END_WIN)
        ) {
            return true;
        }
    }
    return false;
}
