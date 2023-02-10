#!/usr/bin/env node
import {execSync} from 'child_process'
import parse = require('yargs-parser')
import axios = require('axios')
import prompts = require('prompts')
import {dump,load} from 'js-yaml'
import {extract} from 'tar'
import {basename, join, relative} from 'path'
import * as fs from 'fs'
import {AxiosError} from "axios";

const cwd = process.cwd()
let project: string
let rootDir: string
const getAdapterQuestions=(adapter)=>{
    const adapterQuestionMap = {
        icqq: [
            {
                type: () => adapter === 'icqq' ? 'number' : 'text',
                name: 'self_id',
                message: '请输入机器人账号',
            },
            {
                type: () => adapter === 'icqq' ? 'password' : null,
                name: 'password',
                message: '请输入密码(不传则扫码登录)',
            }, {
                type: () => adapter === 'icqq' ? 'select' : null,
                initial: 4,
                message: '请选择登录协议',
                name: 'platform',
                choices: [
                    {
                        title: '安卓手机',
                        value: 1
                    },
                    {
                        title: '安卓平板',
                        value: 2
                    },
                    {
                        title: '安卓手表',
                        value: 3
                    },
                    {
                        title: 'macos',
                        value: 4
                    },
                    {
                        title: 'iPad',
                        selected: true,
                        value: 5
                    }
                ]
            }
        ]
    }
    return adapterQuestionMap[adapter]
}
const argv = parse(process.argv.slice(2), {
    alias: {
        forced: ['f'],
        mirror: ['m'],
        template: ['t'],
        yes: ['y'],
    },
})

function getRef() {
    if (!argv.ref) return 'refs/heads/master'
    if (argv.ref.startsWith('refs/')) return argv.ref
    if (/^[0-9a-f]{40}$/.test(argv.ref)) return argv.ref
    return `refs/heads/${argv.ref}`
}

function supports(command: string) {
    try {
        execSync(command)
        return true
    } catch {
        return false
    }
}

async function getName() {
    if (argv._[0]) return '' + argv._[0]
    const {name} = await prompts({
        type: 'text',
        name: 'name',
        message: 'Project name:',
        initial: 'zhin-app',
    })
    return name.trim() as string
}

async function prepare() {
    if (!fs.existsSync(rootDir)) {
        return fs.mkdirSync(rootDir, {recursive: true})
    }

    const files = fs.readdirSync(rootDir)
    if (!files.length) return

    if (!argv.forced && !argv.yes) {
        console.log(`  Target directory "${project}" is not empty.`)
        const yes = await confirm('Remove existing files and continue?')
        if (!yes) process.exit(0)
    }

    emptyDir(rootDir)
}

// baseline is Node 12 so can't use rmSync
function emptyDir(root: string) {
    for (const file of fs.readdirSync(root)) {
        const abs = join(root, file)
        if (fs.lstatSync(abs).isDirectory()) {
            emptyDir(abs)
            fs.rmdirSync(abs)
        } else {
            fs.unlinkSync(abs)
        }
    }
}

async function confirm(message: string) {
    const {yes} = await prompts({
        type: 'confirm',
        name: 'yes',
        initial: 'Y',
        message,
    })
    return yes as boolean
}

async function scaffold() {

    const mirror = process.env.GITHUB_MIRROR = argv.mirror || 'https://github.com'
    const template = argv.template || 'zhinjs/boilerplate'
    const url = `${mirror}/${template}/archive/${getRef()}.tar.gz`

    try {
        // @ts-ignore
        const {data} = await axios.get<NodeJS.ReadableStream>(url, {responseType: 'stream'})

        await new Promise<void>((resolve, reject) => {
            const stream = data.pipe(extract({cwd: rootDir, newer: true, strip: 1}))
            stream.on('finish', resolve)
            stream.on('error', reject)
        })
    } catch (err) {
        if (err instanceof AxiosError || !err.response) throw err
        const {status, statusText} = err.response
        console.log(`request failed with status code ${status} ${statusText}`)
        process.exit(1)
    }

    writePackageJson()
    writeEnvironment()

    console.log('  Done.\n')
}

function writePackageJson() {
    const filename = join(rootDir, 'package.json')
    const meta = require(filename)
    meta.name = project
    fs.writeFileSync(filename, JSON.stringify(meta, null, 2))
}

function writeEnvironment() {
    const filename = join(rootDir, '.env')
    if (!fs.existsSync(filename)) return
    const content = fs.readFileSync(filename, 'utf8').split('\n').map((line) => {
        if (!line.startsWith('GITHUB_MIRROR = ')) return line
        return `GITHUB_MIRROR = ${process.env.GITHUB_MIRROR}`
    }).join('\n')
    fs.writeFileSync(filename, content)
}

async function initGit() {
    if (argv.yes || !supports('git --version')) return
    const yes = await confirm('Initialize Git for version control?')
    if (!yes) return
    execSync('git init', {stdio: 'ignore', cwd: rootDir})
    console.log('  Done.\n')
}

async function addBot() {
    console.log('  添加你的第一个机器人账号.\n')
    const {adapter} = await prompts(
        {
            type: 'select',
            name: 'adapter',
            message: '请选择一个适配器',
            choices: [
                {
                    title: 'Icqq(内置)',
                    value: 'icqq',
                    selected: true,
                    description: 'Oicq的一个分支，qq协议'
                }
            ]
        })
    const adapterParam = await prompts(getAdapterQuestions(adapter))
    const {master} = await prompts([
        {
            type: () => adapter === 'icqq' ? 'number' : 'text',
            message: '填写机器人主人账号，(一般是你自己的账号)',
            name: 'master',
            initial: () => adapter === 'icqq' ? 1659488338 : '1659488338'
        }
    ])
    const config=load(fs.readFileSync(join(rootDir,'zhin.yaml'),'utf8')) as Record<string, any>
    config.adapters={
        [adapter]:{
            bots:[
                {
                    ...adapterParam,
                    master
                }
            ]
        }
    }
    config.plugin_dir=join(rootDir,'plugins')
    config.data_dir=join(rootDir,'data')
    const pluginConfig=config.plugins||={
        help: null,
        config: null,
        daemon: null,
        login: null,
        logs: null,
        plugin: null,
        status: null,
        watcher:''
    }
    pluginConfig.watcher=rootDir
    fs.writeFileSync(join(rootDir,'zhin.yaml'),dump(config),'utf8')
}

async function install() {
    // with `-y` option, we don't install dependencies
    if (argv.yes) return

    const yes = await confirm('Install and start it now?')
    if (yes) {
        execSync(['npm', 'install'].join(' '), {stdio: 'inherit', cwd: rootDir})
        execSync(['npm', 'run', 'start'].join(' '), {stdio: 'inherit', cwd: rootDir})
    } else {
        console.log('You can start it later by:\n')
        if (rootDir !== cwd) {
            const related = relative(cwd, rootDir)
            console.log(`  cd ${related}`)
        }
        console.log(`  npm install`)
        console.log(`  npm run start`)
        console.log()
    }
}

async function start() {
    console.log()
    console.log(`  Create Zhin`)
    console.log()

    const name = await getName()
    rootDir = join(cwd, name)
    project = basename(rootDir)

    await prepare()
    await scaffold()
    await initGit()
    await addBot()
    await install()
}

start().catch((e) => {
    console.error(e)
})
