const express = require('express');
const path = require('path');
const app = express();
const PORT = 3000;

// 允许访问静态资源（css、images等文件夹）
app.use(express.static(__dirname));

// 首页路由
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`网站已启动：http://localhost:${PORT}`);
});