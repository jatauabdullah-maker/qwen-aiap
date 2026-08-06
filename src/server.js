const express = require('express')
const bodyParser = require('body-parser')
const config = require('./config/index.js')
const cors = require('cors')
const { logger } = require('./utils/logger')
const { initSsxmodManager } = require('./utils/ssxmod-manager')
const DataPersistence = require('./utils/data-persistence')
const app = express()
const path = require('path')
const fs = require('fs')
const modelsRouter = require('./routes/models.js')
const chatRouter = require('./routes/chat.js')
const cliChatRouter = require('./routes/cli.chat.js')
const anthropicRouter = require('./routes/anthropic.js')
const verifyRouter = require('./routes/verify.js')
const accountsRouter = require('./routes/accounts.js')
const settingsRouter = require('./routes/settings.js')

// Render / File data initialization check
if (config.dataSaveMode === 'file') {
  const dataDir = path.join(__dirname, '../data')
  const dataFilePath = path.join(dataDir, 'data.json')
  
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true })
  }

  // If data.json doesn't exist or if RENDER environment variable/token is present, 
  // seed/initialize it dynamically to prevent missing authentication on Render.
  if (!fs.existsSync(dataFilePath) || process.env.RENDER_TOKEN) {
    const initialAccounts = [
      {
        "id": "acc_01",
        "name": "user",
        "token": process.env.RENDER_TOKEN || "",
        "status": "active",
        "enabled": true
      }
    ];
    fs.writeFileSync(dataFilePath, JSON.stringify({ "accounts": initialAccounts }, null, 2))
    logger.info('Initialized data.json from environment variables / defaults', 'SERVER')
  }
}

// 初始化 SSXMOD Cookie 管理器
initSsxmodManager()

app.use(bodyParser.json({ limit: '128mb' }))
app.use(bodyParser.urlencoded({ limit: '128mb', extended: true }))
app.use(cors())

// API路由
app.use(modelsRouter)
app.use(chatRouter)
app.use(cliChatRouter)
app.use(anthropicRouter)
app.use(verifyRouter)
app.use('/api', accountsRouter)
app.use('/api', settingsRouter)

app.use(express.static(path.join(__dirname, '../public/dist')))

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/dist/index.html'), (err) => {
    if (err) {
      logger.error('管理页面加载失败', 'SERVER', '', err)
      res.status(500).send('服务器内部错误')
    }
  })
})

// 处理错误中间件（必须放在所有路由之后）
app.use((err, req, res, next) => {
  logger.error('服务器内部错误', 'SERVER', '', err)
  res.status(500).send('服务器内部错误')
})

// 服务器启动信息
const serverInfo = {
  address: config.listenAddress || 'localhost',
  port: config.listenPort,
  outThink: config.outThink ? '开启' : '关闭',
  legacyReasoning: config.legacyReasoningInContent ? '开启' : '关闭',
  searchInfoMode: config.searchInfoMode === 'table' ? '表格' : '文本',
  dataSaveMode: config.dataSaveMode,
  logLevel: config.logLevel,
  enableFileLog: config.enableFileLog
}

// 应用持久化的运行时设置（web UI > env > hardcoded default）
const applyPersistedSettings = async () => {
  try {
    const persisted = await new DataPersistence().loadSettings()
    if (persisted.chatRetryCount !== undefined && persisted.chatRetryCount !== '') {
      const v = parseInt(persisted.chatRetryCount, 10)
      if (!isNaN(v) && v >= 0) config.chatRetryCount = v
    }
    if (persisted.chatRetryBackoffMs !== undefined && persisted.chatRetryBackoffMs !== '') {
      const v = parseInt(persisted.chatRetryBackoffMs, 10)
      if (!isNaN(v) && v >= 0) config.chatRetryBackoffMs = v
    }
    if (persisted.apiKeys?.length > 1) {
      config.apiKeys = persisted.apiKeys;
      config.adminKey = persisted.apiKeys[0];
    }
  } catch (err) {
    logger.warn('加载持久化设置失败, 使用 env/默认值', 'CONFIG', '', err.message)
  }
}

const startServer = () => {
  // Use Render's assigned process.env.PORT if available, else use config.listenPort
  const portToUse = process.env.PORT || config.listenPort

  if (config.listenAddress) {
    app.listen(portToUse, config.listenAddress, () => {
      logger.server('服务器启动成功', 'SERVER', { ...serverInfo, port: portToUse })
      logger.info('开源地址: https://github.com/Rfym21/Qwen2API', 'INFO')
      logger.info('电报群聊: https://t.me/nodejs_project', 'INFO')
    })
  } else {
    app.listen(portToUse, () => {
      logger.server('服务器启动成功', 'SERVER', { ...serverInfo, port: portToUse })
      logger.info('开源地址: https://github.com/Rfym21/Qwen2API', 'INFO')
      logger.info('电报群聊: https://t.me/nodejs_project', 'INFO')
    })
  }
}

applyPersistedSettings().finally(startServer)
