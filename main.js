document.addEventListener('DOMContentLoaded', () => {
    console.log("AI图像放大系统 (智能分割版) 已加载");
    // =================================================================
// ▼▼▼▼▼ 插件接口：接收来自Chrome插件的图片数据 ▼▼▼▼▼
// =================================================================

/**
 * 将 dataURL (base64) 转换为 File 对象
 * @param {string} dataurl - 图片的 dataURL
 * @param {string} filename - 要创建的文件名
 * @returns {File} - 转换后的 File 对象
 */
function dataURLtoFile(dataurl, filename) {
    let arr = dataurl.split(','),
        // 从 dataURL 头部获取 MIME 类型，例如 "image/png"
        mime = arr[0].match(/:(.*?);/)[1],
        // 解码 base64 数据
        bstr = atob(arr[1]),
        n = bstr.length,
        u8arr = new Uint8Array(n);
    while (n--) {
        u8arr[n] = bstr.charCodeAt(n);
    }
    return new File([u8arr], filename, {type: mime});
}

// 监听由Chrome插件派发的 'aiUpscalerInjectData' 自定义事件
window.addEventListener('aiUpscalerInjectData', (event) => {
    console.log('成功接收到来自AI图像放大插件的数据！', event.detail);
    
    // 确保事件的 detail 中包含 imageDataUrl
    if (event.detail && event.detail.imageDataUrl) {
        const imageDataUrl = event.detail.imageDataUrl;
        
        // 生成一个动态的文件名
        const fileExtension = imageDataUrl.substring("data:image/".length, imageDataUrl.indexOf(";base64"));
        const fileName = `from_extension_${Date.now()}.${fileExtension || 'png'}`;
        
        // 将 dataURL 转换为 File 对象
        const imageFile = dataURLtoFile(imageDataUrl, fileName);

        // 调用应用中已有的图片处理函数，就像用户手动上传了一样
        handleImageUpload(imageFile);

        // （可选）更新状态，给用户一个明确的反馈
        const statusDiv = document.getElementById('status');
        if(statusDiv) {
            statusDiv.innerHTML = '<i class="fas fa-check-circle"></i> 图片已从插件成功载入！';
        }
    } else {
        console.error('从插件接收到的数据格式不正确。');
    }
});

// =================================================================
// ▲▲▲▲▲ 插件接口：代码结束 ▲▲▲▲▲
// =================================================================
    // DOM元素
    const fileInput = document.getElementById('fileInput');
    const uploadArea = document.getElementById('uploadArea');
    const statusDiv = document.getElementById('status');
    const originalImageBox = document.getElementById('originalImageBox');
    const originalImage = document.getElementById('originalImage');
    const originalInfo = document.getElementById('originalInfo');
    const resultContainer = document.getElementById('resultContainer');
    const resultCanvas = document.getElementById('resultCanvas');
    const resultInfo = document.getElementById('resultInfo');
    const executeBtn = document.getElementById('executeBtn');
    const downloadBtn = document.getElementById('downloadBtn');
    const waifu2xArch = document.getElementById('waifu2x-arch');
    const waifu2xStyle = document.getElementById('waifu2x-style');
    const waifu2xNoise = document.getElementById('waifu2x-noise');
    const waifu2xScale = document.getElementById('waifu2x-scale');
    const memorySlider = document.getElementById('memorySlider');
    const memoryValue = document.getElementById('memoryValue');
    const progressBar = document.getElementById('progressBar');
    const progressText = document.getElementById('progressText');
    const previewOverlay = document.getElementById('previewOverlay');

    const tilingSlider = document.getElementById('tilingSlider');
    const tilingValue = document.getElementById('tilingValue');
    const tilingInfo = document.getElementById('tilingInfo');

    const memoryOptions = document.querySelectorAll('.memory-option');
    const MEMORY_OPTIONS = [0.5, 1.0, 2.0, 4.0];
    let originalFile = null;
    let upscalerWorker;
    let currentTiles = [];
    let tilingOptions = [];
    
    // ★ 核心修改 1: 新增一个状态标志
    let isGridPrepared = false;

    function initializeWorker() {
        if (typeof(Worker) === "undefined") {
            statusDiv.innerHTML = '<i class="fas fa-times-circle"></i> 不支持Web Worker';
            return;
        }
        statusDiv.innerHTML = '<i class="fas fa-cogs"></i> 正在启动AI Worker...';
        upscalerWorker = new Worker('upscaler-worker.js');
        upscalerWorker.onmessage = handleWorkerMessage;
        upscalerWorker.onerror = (e) => {
            console.error(`Worker 发生严重错误:`, e);
            const payload = {
                message: e.message || '未知Worker错误',
                stack: e.stack || 'No stack available.'
            };
            handleWorkerMessage({ data: { type: 'error', payload } });
        }
    }

    function handleWorkerMessage(event) {
        const { type, payload } = event.data;
        switch (type) {
            case 'status':
                statusDiv.innerHTML = `<i class="fas fa-info-circle"></i> ${payload.message}`;
                if (payload.message.includes('加载模型')) {
                    previewOverlay.textContent = payload.message;
                }
                break;
    
            case 'progress':
                updateProgress(payload.progress, payload.tile, payload.task);
                break;
    
            case 'tile_done':
                drawTileToCanvas(payload);
                break;
    
            case 'all_done':
                statusDiv.innerHTML = '<i class="fas fa-check-circle"></i> 处理完成！可以下载图片。';
                previewOverlay.textContent = "处理完成！";
                downloadBtn.style.display = 'flex';
                enableControls();
                break;
                
            case 'error':
                console.error("Worker Error:", payload);
                let friendlyMessage = payload.message;
                // 检查是否是输入形状错误
                if (payload.message.includes('Invalid input shape: {2,2}')) {
                    friendlyMessage = '分割粒度/图片太小，请调整分割大小或确保图片足够大';
                } 
                if (payload.stack === 'No stack available.' && !isNaN(parseInt(payload.message))) {
                    friendlyMessage = '分割大小超出处理能力';
                }
                statusDiv.innerHTML = `<i class="fas fa-times-circle"></i> 处理失败: <span style="font-weight:bold;">${friendlyMessage}</span>`;
                previewOverlay.textContent = `错误: ${friendlyMessage}`;
                enableControls();
                break;
        }
    }

    function drawTileToCanvas(payload) {
        const { data, width, height, dx, dy } = payload;
        const ctx = resultCanvas.getContext('2d');
        const imageData = new ImageData(new Uint8ClampedArray(data), width, height);
        ctx.putImageData(imageData, dx, dy);
    }
    
    function updateProgress(progress, tile, task) {
        const percentage = Math.round(progress * 100);
        progressBar.style.width = `${percentage}%`;
        progressText.textContent = `${percentage}%`;
        previewOverlay.textContent = `处理中: ${task} (${percentage}%)`;
        if (tile && currentTiles.length > 0) {
            const { col, row, cols, rows } = tile;
            const tileIndex = row * cols + col;
            if (tileIndex < currentTiles.length) {
                document.querySelectorAll('.tile-cell.active').forEach(cell => cell.classList.remove('active'));
                currentTiles[tileIndex].classList.add('active');
            }
        }
    }
    function handleImageUpload(file) {
        if (!file) return;
        originalFile = file;
        
        const reader = new FileReader();
        reader.onload = (e) => {
            const imageDataUrl = e.target.result;
            const img = new Image();
            
            img.onload = () => {
                const fileSizeMB = (file.size / 1024 / 1024).toFixed(2);
                originalInfo.textContent = `${img.width}×${img.height} • ${fileSizeMB} MB`;
                
                updateTilingOptions(img.naturalWidth, img.naturalHeight);

                originalImage.src = imageDataUrl;
                resultContainer.style.display = 'none';
                downloadBtn.style.display = 'none';
                originalImageBox.style.display = 'flex';
                executeBtn.style.display = 'flex';
                statusDiv.innerHTML = '<i class="fas fa-image"></i> 图片已加载，点击 "开始处理"';
                previewOverlay.textContent = "图片已加载";
                enableControls();
            };
            img.src = imageDataUrl;
        };
        reader.readAsDataURL(file);
    }
    
    function executeUpscale() {
        if (!originalFile || tilingOptions.length === 0) {
            alert('请先上传图片并等待分割方案计算完成！');
            return;
        }
        currentTiles = [];
    
        disableControls();
        const selectedTiling = tilingOptions[tilingSlider.value];
        const suggestedTileSize = Math.max(...selectedTiling.tileSize.split('×').map(Number));
    
        const config = {
            tiling: {
                suggestedTileSize: suggestedTileSize,
            },
            waifu2x: { 
                arch: waifu2xArch.value, 
                style: waifu2xStyle.value, 
                noise: waifu2xNoise.value, 
                scale: parseInt(waifu2xScale.value, 10) 
            },
            memoryLevel: parseInt(memorySlider.value, 10)
        };
        
        if (config.waifu2x.arch === 'cunet') {
            config.waifu2x.scale = 2;
        }
        
        const tasks = getWaifu2xTasks(config.waifu2x);
        let effectiveScale = 1;
        tasks.forEach(task => {
            effectiveScale *= task.scale;
        });
        
        const targetWidth = Math.round(originalImage.naturalWidth * effectiveScale);
        const targetHeight = Math.round(originalImage.naturalHeight * effectiveScale);
    
        resultCanvas.width = targetWidth;
        resultCanvas.height = targetHeight;
        resultContainer.style.display = 'flex';
        const ctx = resultCanvas.getContext('2d');
        ctx.clearRect(0, 0, targetWidth, targetHeight);
        resultInfo.textContent = `${targetWidth}×${targetHeight} • ${(targetWidth * targetHeight / 1000000).toFixed(2)} MP`;
        statusDiv.innerHTML = '<i class="fas fa-paper-plane"></i> 任务已发送...';
        previewOverlay.textContent = "准备处理...";
        
        upscalerWorker.postMessage({ type: 'start', file: originalFile, config: config });
    }
    
    // in main.js
function getWaifu2xTasks(waifuConfig) {
    const { arch, style, noise, scale } = waifuConfig;
    
    // ★ 修改这里：将判断条件从 '0' 改为 '-1'
    if (scale === 1 && noise === '-1') return []; // 1倍放大且无降噪，则任务列表为空
    
    const isCunet = arch === 'cunet';
    const effectiveStyle = isCunet ? 'art' : style;
    const basePath = `./models/waifu2x/${arch}/${effectiveStyle}/`;
    
    let tasks = [];
    
    // ★ 修改这里：处理仅降噪的情况 (scale=1)
    if (noise !== '-1') { // 如果选择了任何一个降噪等级
        if (scale === 1) {
             // 如果是1倍放大，则添加一个降噪任务
             tasks.push({ modelPath: `${basePath}noise${noise}.onnx`, scale: 1 });
        }
    }

    if (scale > 1) {
        if (isCunet) {
            // ★ 修改这里：判断条件从 '0' 改为 '-1'
            let modelName = (noise === '-1') ? `scale2x.onnx` : `noise${noise}_scale2x.onnx`;
            tasks.push({ modelPath: basePath + modelName, scale: 2 });
        } else { // swin_unet
            // ★ 修改这里：判断条件从 '0' 改为 '-1'
             if (noise === '-1') {
                // 仅放大
                tasks.push({ modelPath: `${basePath}scale${scale}x.onnx`, scale: scale });
             } else {
                // 降噪 + 放大（根据您的文件结构，这通常是一个组合模型）
                tasks.push({ modelPath: `${basePath}noise${noise}_scale${scale}x.onnx`, scale: scale });
             }
        }
    }
    return tasks;
}
    
    function disableControls() {
        uploadArea.style.pointerEvents = 'none';
        uploadArea.style.opacity = 0.6;
        executeBtn.disabled = true;
        document.querySelectorAll('.settings-card select, .settings-card input').forEach(el => el.disabled = true);
    }
    function enableControls() {
        uploadArea.style.pointerEvents = 'auto';
        uploadArea.style.opacity = 1;
        executeBtn.disabled = false;
        document.querySelectorAll('.settings-card select, .settings-card input').forEach(el => el.disabled = false);
        tilingSlider.disabled = tilingOptions.length <= 1;
        toggleWaifu2xOptions();
    }
    
    function toggleWaifu2xOptions() {
        const arch = waifu2xArch.value;
        const scaleSelect = waifu2xScale;
        const styleSelect = waifu2xStyle;
        const scaleOptions = {
            '1': document.querySelector('#waifu2x-scale option[value="1"]'),
            '2': document.querySelector('#waifu2x-scale option[value="2"]'),
            '4': document.querySelector('#waifu2x-scale option[value="4"]'),
        };

        if (arch === 'cunet') {
            styleSelect.value = 'art';
            styleSelect.disabled = true;

            scaleOptions['1'].disabled = false;
            scaleOptions['2'].disabled = false;
            scaleOptions['4'].disabled = true;
            
            if (scaleSelect.value !== '2') {
                scaleSelect.value = '2';
            }
        } else if (arch === 'swin_unet') {
            styleSelect.disabled = false;
            scaleOptions['1'].disabled = false;
            scaleOptions['2'].disabled = false;
            scaleOptions['4'].disabled = false;
            
            if (scaleSelect.value === '3') {
                scaleSelect.value = '2';
            }
        }
    }

    function updateTilingOptions(width, height) {
        const MIN_TILE_SIZE = 8;
        const MAX_TILE_SIZE = 640;
        let options = new Map();

        const sizesToTry = [16,32, 64, 96, 128, 192, 256, 384, 512]; 

        for (const size of sizesToTry) {
            const cols = Math.max(1, Math.round(width / size));
            const rows = Math.max(1, Math.round(height / size));
            
            const tileW = Math.ceil(width / cols);
            const tileH = Math.ceil(height / rows);

            if (tileW >= MIN_TILE_SIZE && tileH >= MIN_TILE_SIZE && 
                tileW <= MAX_TILE_SIZE && tileH <= MAX_TILE_SIZE)
            {
                const key = `${cols}x${rows}`;
                if (!options.has(key)) {
                    options.set(key, { 
                        cols, 
                        rows, 
                        tileSize: `${tileW}×${tileH}` 
                    });
                }
            }
        }
        
        if (!options.has('1x1')) {
            options.set('1x1', { cols: 1, rows: 1, tileSize: `${width}×${height}` });
        }
        
        tilingOptions = Array.from(options.values()).sort((a, b) => (b.cols * b.rows) - (a.cols * b.rows));
        
        let defaultIndex = tilingOptions.findIndex(opt => {
             const [w, h] = opt.tileSize.split('×').map(Number);
             return w >= 30 && h >= 30;
        });
        if (defaultIndex === -1) defaultIndex = 0;

        tilingSlider.disabled = tilingOptions.length <= 1;
        tilingSlider.max = tilingOptions.length - 1;
        tilingSlider.value = defaultIndex;
        updateTilingInfoText();
    }

    function updateTilingInfoText() {
        if (tilingOptions.length > 0) {
            const selectedIndex = parseInt(tilingSlider.value, 10);
            const selectedOption = tilingOptions[selectedIndex];
            if (selectedOption) {
                tilingValue.textContent = selectedOption.tileSize;
                const totalTiles = selectedOption.cols * selectedOption.rows;
                tilingInfo.textContent = `将分割成 ${totalTiles} 块`;
            }
        } else {
            tilingValue.textContent = '自动';
            tilingInfo.textContent = '上传图片后将自动计算分割方案。';
        }
    }
    
    tilingSlider.addEventListener('input', updateTilingInfoText);
    uploadArea.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (event) => {
        if (event.target.files[0]) handleImageUpload(event.target.files[0]);
    });
    
    ['dragover', 'drop'].forEach(eventName => {
        uploadArea.addEventListener(eventName, e => {
            e.preventDefault();
            e.stopPropagation();
        });
    });
    
    uploadArea.addEventListener('dragenter', () => uploadArea.classList.add('dragging'));
    uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('dragging'));
    
    uploadArea.addEventListener('drop', (e) => {
        uploadArea.classList.remove('dragging');
        if (e.dataTransfer.files[0]) handleImageUpload(e.dataTransfer.files[0]);
    });
    
    executeBtn.addEventListener('click', executeUpscale);
    
    waifu2xArch.addEventListener('change', toggleWaifu2xOptions);
    
    downloadBtn.addEventListener('click', () => {
        if (!resultCanvas || resultCanvas.width === 0) return;
        const link = document.createElement('a');
        link.href = resultCanvas.toDataURL('image/png');
        const fileName = originalFile ? 
            originalFile.name.split('.').slice(0, -1).join('.') : 'enhanced';
        const scale = document.getElementById('waifu2x-scale').value;
        link.download = `${fileName}_waifu2x_${scale}x_${waifu2xArch.value}.png`;
        link.click();
    });
    
    memorySlider.addEventListener('input', () => {
        const level = parseInt(memorySlider.value, 10);
        memoryValue.textContent = `${MEMORY_OPTIONS[level]} GB`;
        memoryOptions.forEach((option, index) => {
            option.classList.toggle('active', index === level);
        });
    });
    
    memoryOptions.forEach((option, index) => {
        option.addEventListener('click', () => {
            memorySlider.value = index;
            memorySlider.dispatchEvent(new Event('input'));
        });
    });
    
    initializeWorker();
    toggleWaifu2xOptions();
    memorySlider.dispatchEvent(new Event('input'));
});