document.addEventListener('DOMContentLoaded', () => {
    console.log("AI图像放大系统 (智能分割版) 已加载");

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
    const tileGrid = document.getElementById('tileGrid');

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
            
            case 'grid_info':
                // Worker已发来精确的网格信息，现在画格子！
                prepareTileGrid(payload);
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
        
        // 清空旧的网格
        tileGrid.innerHTML = ''; 
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
        
        // 注意：这里不再调用 prepareTileGrid，等待 Worker 的消息
        upscalerWorker.postMessage({ type: 'start', file: originalFile, config: config });
    }
    
    function getWaifu2xTasks(waifuConfig) {
        const { arch, style, noise, scale } = waifuConfig;
        if (scale === 1 && noise === '0') return [];
        
        const isCunet = arch === 'cunet';
        const effectiveStyle = isCunet ? 'art' : style;
        const basePath = `./models/waifu2x/${arch}/${effectiveStyle}/`;
        
        let tasks = [];
        
        if (noise !== '0') {
            if (!isCunet) {
                tasks.push({ modelPath: `${basePath}noise${noise}.onnx`, scale: 1 });
            }
        }
        if (scale > 1) {
            if (isCunet) {
                let modelName = (noise === '0') ? `scale2x.onnx` : `noise${noise}_scale2x.onnx`;
                tasks.push({ modelPath: basePath + modelName, scale: 2 });
            } else { // swin_unet
                tasks.push({ modelPath: `${basePath}scale${scale}x.onnx`, scale: scale });
            }
        }
        return tasks;
    }
    
    function prepareTileGrid(gridInfo) {
        tileGrid.innerHTML = '';
        currentTiles = [];
        
        const { cols, rows, tileWidth, tileHeight, stepX, stepY } = gridInfo;
    
        for (let row = 0; row < rows; row++) {
            for (let col = 0; col < cols; col++) {
                const tile = document.createElement('div');
                tile.className = 'tile-cell';
                
                // 使用Worker传来的精确尺寸和位置
                tile.style.width = `${tileWidth}px`;
                tile.style.height = `${tileHeight}px`;
                tile.style.left = `${col * stepX}px`;
                tile.style.top = `${row * stepY}px`;
    
                tileGrid.appendChild(tile);
                currentTiles.push(tile);
            }
        }
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
            '2': document.querySelector('#waifu2x-scale option[value="2"]'),
            '3': document.querySelector('#waifu2x-scale option[value="3"]'),
            '4': document.querySelector('#waifu2x-scale option[value="4"]'),
        };

        if (arch === 'cunet') {
            styleSelect.value = 'art';
            styleSelect.disabled = true;

            scaleOptions['2'].disabled = false;
            scaleOptions['3'].disabled = true;
            scaleOptions['4'].disabled = true;
            
            if (scaleSelect.value !== '2') {
                scaleSelect.value = '2';
            }
        } else if (arch === 'swin_unet') {
            styleSelect.disabled = false;

            scaleOptions['2'].disabled = false;
            scaleOptions['3'].disabled = true;
            scaleOptions['4'].disabled = false;
            
            if (scaleSelect.value === '3') {
                scaleSelect.value = '2';
            }
        }
    }

    function updateTilingOptions(width, height) {
        const MIN_TILE_SIZE = 16;
        const MAX_TILE_SIZE = 640;
        let options = new Map();

        const sizesToTry = [32, 64, 96, 128, 192, 256, 384, 512]; 

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
        
        tilingOptions = Array.from(options.values()).sort((a, b) => (a.cols * a.rows) - (b.cols * b.rows));
        
        let defaultIndex = tilingOptions.findIndex(opt => {
             const [w, h] = opt.tileSize.split('×').map(Number);
             return w >= 32 && h >= 32;
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