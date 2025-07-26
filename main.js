document.addEventListener('DOMContentLoaded', () => { 
    function dataURLtoFile(dataurl, filename) {
        let arr = dataurl.split(','),
            mime = arr[0].match(/:(.*?);/)[1],
            bstr = atob(arr[1]),
            n = bstr.length,
            u8arr = new Uint8Array(n);
        while (n--) {
            u8arr[n] = bstr.charCodeAt(n);
        }
        return new File([u8arr], filename, {type: mime});
    }

    window.addEventListener('aiUpscalerInjectData', (event) => {
        if (event.detail && event.detail.imageDataUrl) {
            const imageDataUrl = event.detail.imageDataUrl;
            const fileExtension = imageDataUrl.substring("data:image/".length, imageDataUrl.indexOf(";base64"));
            const fileName = `from_extension_${Date.now()}.${fileExtension || 'png'}`;
            const imageFile = dataURLtoFile(imageDataUrl, fileName);
            handleImageUpload(imageFile);
            const statusDiv = document.getElementById('status');
            if(statusDiv) {
                statusDiv.innerHTML = '<i class="fas fa-check-circle"></i> 图片已从插件成功载入！';
            }
        } else {
            console.error('从插件接收到的数据格式不正确。');
        }
    });

    //=================================================================
    // ▼▼▼ DOM元素获取 ▼▼▼
    //=================================================================
    const fileInput = document.getElementById('fileInput');
    const uploadArea = document.getElementById('uploadArea');
    const statusDiv = document.getElementById('status');
    const originalImage = document.getElementById('originalImage');
    const originalInfo = document.getElementById('originalInfo');
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
    const postProcessCard = document.getElementById('postProcessCard');
    const targetWidthInput = document.getElementById('targetWidthInput');
    const sizeSlider = document.getElementById('sizeSlider');
    const targetDimensions = document.getElementById('targetDimensions');
    const presetButtons = document.querySelectorAll('.preset-btn');
    const comparisonContainer = document.getElementById('comparison-container');
    const resultBox = document.getElementById('resultBox');
    const comparisonHandle = document.getElementById('comparison-handle');
    const imageWrapper = document.getElementById('image-wrapper');

    //=================================================================
    // ▼▼▼ 全局状态变量 ▼▼▼
    //=================================================================
    const MEMORY_OPTIONS = [0.5, 1.0, 2.0, 4.0];
    let originalFile = null;
    let originalImageDimensions = { width: 0, height: 0 };
    let upscalerWorker;
    let tilingOptions = [];
    let resultAspectRatio = 1;

    //=================================================================
    // ▼▼▼ 核心函数区 ▼▼▼
    //=================================================================

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
        };
    }

    function handleWorkerMessage(event) {
        const { type, payload } = event.data;
        switch (type) {
            case 'status':
                statusDiv.innerHTML = `<i class="fas fa-info-circle"></i> ${payload.message}`;
                if (payload.message.includes('加载') || payload.message.includes('下载') || payload.message.includes('解析')) {
                    previewOverlay.textContent = payload.message;
                }
                break;
            case 'model_load_progress':
                const { progress, modelName } = payload;
                progressBar.style.width = `${progress}%`;
                progressText.textContent = `${progress}%`;
                statusDiv.innerHTML = `<i class="fas fa-download"></i> 正在下载AI模型 ${modelName}... ${progress}%`;
                previewOverlay.textContent = `下载模型: ${modelName} (${progress}%)`;
                break;
            case 'progress':
                progressBar.style.transition = 'width 0.1s ease-in-out';
                updateProgress(payload.progress, payload.tile, payload.task);
                break;
            case 'tile_done':
                drawTileToCanvas(payload);
                break;
            case 'all_done':
                resultCanvas.style.backgroundColor = 'transparent';
                statusDiv.innerHTML = '<i class="fas fa-check-circle"></i> 处理完成！请调整最终尺寸并下载。';
                previewOverlay.textContent = "处理完成！";
                downloadBtn.style.display = 'flex';
                initializePostProcessControls();
                enableControls();
                break;
            case 'error':
                resultCanvas.style.backgroundColor = 'transparent';
                console.error("Worker Error:", payload);
                let friendlyMessage = payload.message;
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

    function handleImageUpload(file) {
        if (!file) return;
        originalFile = file;
        postProcessCard.style.display = 'none';

        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                originalImageDimensions = { width: img.naturalWidth, height: img.naturalHeight };
                const fileSizeMB = (file.size / 1024 / 1024).toFixed(2);

                originalInfo.textContent = `原始(右): ${originalImageDimensions.width}×${originalImageDimensions.height}`;
                resultInfo.textContent = '放大后(左): 0×0';
                
                updateTilingOptions(originalImageDimensions.width, originalImageDimensions.height);
                updateTilingInfoText();

                originalImage.src = e.target.result;
                setPreviewElementsSize(originalImageDimensions.width, originalImageDimensions.height);
                resultCanvas.width = originalImageDimensions.width;
                resultCanvas.height = originalImageDimensions.height;
                const ctx = resultCanvas.getContext('2d');
                ctx.clearRect(0, 0, resultCanvas.width, resultCanvas.height);
                executeBtn.style.display = 'flex';
                statusDiv.innerHTML = '<i class="fas fa-image"></i> 图片已加载，点击 "开始处理"';
                previewOverlay.textContent = "图片已加载";
                resetComparisonSlider();
                enableControls();
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    }

    function executeUpscale() {
        if (!originalFile || tilingOptions.length === 0) {
            alert('请先上传图片并等待分割方案计算完成！');
            return;
        }
        saveSettings();
        postProcessCard.style.display = 'none';
        disableControls();

        const config = {
            tiling: {
                suggestedTileSize: Math.max(...tilingOptions[tilingSlider.value].tileSize.split('×').map(Number)),
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
        tasks.forEach(task => { effectiveScale *= task.scale; });
        
        const targetWidth = Math.round(originalImageDimensions.width * effectiveScale);
        const targetHeight = Math.round(originalImageDimensions.height * effectiveScale);
    
        resultCanvas.width = targetWidth;
        resultCanvas.height = targetHeight;
        setPreviewElementsSize(originalImageDimensions.width, originalImageDimensions.height);
        const ctx = resultCanvas.getContext('2d');
        ctx.clearRect(0, 0, targetWidth, targetHeight);
        resultCanvas.style.backgroundColor = '#48484848';

        resultInfo.textContent = `放大后(左): ${targetWidth}×${targetHeight}`;
        statusDiv.innerHTML = '<i class="fas fa-paper-plane"></i> 任务已发送...';
        previewOverlay.textContent = "准备处理...";
        
        upscalerWorker.postMessage({ type: 'start', file: originalFile, config: config });
    }
    function setPreviewElementsSize(width, height) {
        // 设置 img 元素的显示尺寸
        originalImage.style.width = `${width}px`;
        originalImage.style.height = `${height}px`;

        resultCanvas.style.width = `${width}px`;
        resultCanvas.style.height = `${height}px`;

        const originalBox = document.getElementById('originalImageBox');
        const resultBox = document.getElementById('resultBox');
        if (originalBox) {
            originalBox.style.width = `${width}px`;
            originalBox.style.height = `${height}px`;
        }
        if (resultBox) {
            resultBox.style.width = `${width}px`; 
            resultBox.style.height = `${height}px`;
        }
    }
    function initializePostProcessControls() {
        postProcessCard.style.display = 'block';
        resultAspectRatio = resultCanvas.height / resultCanvas.width;
        
        const minWidth = Math.round(originalImageDimensions.width * 0.1);
        const maxWidth = resultCanvas.width;
        sizeSlider.min = minWidth;
        sizeSlider.max = maxWidth;
        
        syncControls(maxWidth);
    }

    function syncControls(newWidth) {
        const width = Math.max(1, Math.round(newWidth));
        targetWidthInput.value = width;
        sizeSlider.value = width;
        updateTargetDimensionsDisplay(width);
        updateActivePresetButton(width);
    }

    function updateTargetDimensionsDisplay(width) {
        const height = Math.round(width * resultAspectRatio);
        targetDimensions.textContent = `${width} × ${height}`;
    }

    function updateActivePresetButton(currentWidth) {
        let activeButton = null;
        presetButtons.forEach(btn => {
            const type = btn.dataset.type;
            const value = parseFloat(btn.dataset.value);
            let targetWidth = 0;

            if (type === 'scale') {
                targetWidth = Math.round(originalImageDimensions.width * value);
            } else if (type === 'original_percent') {
                targetWidth = Math.round(originalImageDimensions.width * value);
            } else if (type === 'pixel') {
                targetWidth = value;
            }

            if (currentWidth === targetWidth) {
                activeButton = btn;
            }
        });
        
        presetButtons.forEach(btn => btn.classList.remove('active'));
        if (activeButton) {
            activeButton.classList.add('active');
        }
    }

    uploadArea.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (event) => {
        if (event.target.files[0]) handleImageUpload(event.target.files[0]);
    });
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        uploadArea.addEventListener(eventName, e => {
            e.preventDefault();
            e.stopPropagation();
            if (eventName === 'dragenter' || eventName === 'dragover') {
                uploadArea.classList.add('dragging');
            } else {
                uploadArea.classList.remove('dragging');
            }
        });
    });
    uploadArea.addEventListener('drop', (e) => {
        if (e.dataTransfer.files[0]) handleImageUpload(e.dataTransfer.files[0]);
    });

    executeBtn.addEventListener('click', executeUpscale);
    downloadBtn.addEventListener('click', () => {
        if (!resultCanvas || resultCanvas.width === 0) return;
        const targetWidth = parseInt(targetWidthInput.value, 10);
        if (isNaN(targetWidth) || targetWidth <= 0) {
            alert('请输入一个有效的目标宽度！');
            return;
        }

        const targetHeight = Math.round(targetWidth * resultAspectRatio);
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = targetWidth;
        tempCanvas.height = targetHeight;
        const tempCtx = tempCanvas.getContext('2d');
        tempCtx.imageSmoothingQuality = 'high';
        
        tempCtx.drawImage(resultCanvas, 0, 0, targetWidth, targetHeight);

        const link = document.createElement('a');
        link.href = tempCanvas.toDataURL('image/png');
        const fileName = originalFile ? originalFile.name.split('.').slice(0, -1).join('.') : 'enhanced';
        link.download = `${fileName}_w${targetWidth}.png`;
        link.click();
    });


    waifu2xArch.addEventListener('change', toggleWaifu2xOptions);
    tilingSlider.addEventListener('input', updateTilingInfoText);
    memorySlider.addEventListener('input', () => {
        const level = parseInt(memorySlider.value, 10);
        memoryValue.textContent = `${MEMORY_OPTIONS[level]} GB`;
        memoryOptions.forEach((option, index) => option.classList.toggle('active', index === level));
    });
    memoryOptions.forEach((option, index) => {
        option.addEventListener('click', () => {
            memorySlider.value = index;
            memorySlider.dispatchEvent(new Event('input'));
        });
    });
    
    presetButtons.forEach(button => {
        button.addEventListener('click', () => {
            const type = button.dataset.type;
            const value = parseFloat(button.dataset.value);
            let newWidth = 0;

            if (type === 'scale') {
                newWidth = Math.round(originalImageDimensions.width * value);
            } else if (type === 'original_percent') {
                newWidth = Math.round(originalImageDimensions.width * value);
            } else if (type === 'pixel') {
                newWidth = value;
            }
            syncControls(newWidth);
        });
    });
    sizeSlider.addEventListener('input', (e) => syncControls(parseInt(e.target.value, 10)));
    targetWidthInput.addEventListener('input', (e) => {
        const val = parseInt(e.target.value, 10);
        if (!isNaN(val)) {
            syncControls(val);
        }
    });

    let isDragging = false;
    comparisonHandle.addEventListener('mousedown', () => { isDragging = true; });
    window.addEventListener('mouseup', () => { isDragging = false; });
    window.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        const rect = comparisonContainer.getBoundingClientRect();
        let position = (e.clientX - rect.left) / rect.width;
        position = Math.max(0, Math.min(1, position));
        resultBox.style.width = `${position * 100}%`;
        comparisonHandle.style.left = `${position * 100}%`;
    });


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
    }
    function resetComparisonSlider() {
        requestAnimationFrame(() => {
            resultBox.style.width = '50%';
            comparisonHandle.style.left = '50%';
        });
    }
    function getWaifu2xTasks(waifuConfig) {
        const { arch, style, noise, scale } = waifuConfig;
        if (scale === 1 && noise === '-1') return [];
        const isCunet = arch === 'cunet';
        const effectiveStyle = isCunet ? 'art' : style;
        const basePath = `./models/waifu2x/${arch}/${effectiveStyle}/`;
        let tasks = [];
        if (noise !== '-1') {
            if (scale === 1) {
                 tasks.push({ modelPath: `${basePath}noise${noise}.onnx`, scale: 1 });
            }
        }
        if (scale > 1) {
            let modelName;
            if (isCunet) {
                modelName = (noise === '-1') ? `scale2x.onnx` : `noise${noise}_scale2x.onnx`;
                tasks.push({ modelPath: basePath + modelName, scale: 2 });
            } else {
                 if (noise === '-1') {
                    tasks.push({ modelPath: `${basePath}scale${scale}x.onnx`, scale: scale });
                 } else {
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
        document.querySelectorAll('.settings-card select, .settings-card input, .post-process-controls button, .post-process-controls input').forEach(el => el.disabled = true);
    }
    function enableControls() {
        uploadArea.style.pointerEvents = 'auto';
        uploadArea.style.opacity = 1;
        executeBtn.disabled = false;
        document.querySelectorAll('.settings-card select, .settings-card input, .post-process-controls button, .post-process-controls input').forEach(el => el.disabled = false);
        tilingSlider.disabled = tilingOptions.length <= 1;
        toggleWaifu2xOptions();
    }
    function toggleWaifu2xOptions() {
        const arch = waifu2xArch.value;
        const scaleSelect = waifu2xScale;
        const styleSelect = waifu2xStyle;
        const noiseSelect = waifu2xNoise;
        const scaleOptions = {
            '1': document.querySelector('#waifu2x-scale option[value="1"]'),
            '2': document.querySelector('#waifu2x-scale option[value="2"]'),
            '4': document.querySelector('#waifu2x-scale option[value="4"]'),
        };
        if (arch === 'cunet') {
            styleSelect.value = 'art'; styleSelect.disabled = true;
            noiseSelect.disabled = false;
            scaleOptions['1'].disabled = false; scaleOptions['2'].disabled = false; scaleOptions['4'].disabled = true;
            if (scaleSelect.value === '4') { scaleSelect.value = '2'; }
        } else if (arch === 'swin_unet') {
            styleSelect.disabled = false; noiseSelect.disabled = false;
            scaleOptions['1'].disabled = false; scaleOptions['2'].disabled = false; scaleOptions['4'].disabled = false;
        } else if (arch === 'x4s') {
            styleSelect.disabled = true; noiseSelect.disabled = true;
            scaleSelect.value = '4';
            scaleOptions['1'].disabled = true; scaleOptions['2'].disabled = true; scaleOptions['4'].disabled = false;
        }
    }
    function saveSettings() {
        const settings = {
            arch: waifu2xArch.value, style: waifu2xStyle.value, noise: waifu2xNoise.value,
            scale: waifu2xScale.value, memory: memorySlider.value,
        };
        localStorage.setItem('userUpscalerSettings', JSON.stringify(settings));
    }
    function loadSettings() {
        const savedSettings = localStorage.getItem('userUpscalerSettings');
        if (savedSettings) {
            const settings = JSON.parse(savedSettings);
            waifu2xArch.value = settings.arch || 'swin_unet';
            waifu2xStyle.value = settings.style || 'photo';
            waifu2xNoise.value = settings.noise || '1';
            waifu2xScale.value = settings.scale || '2';
            memorySlider.value = settings.memory || '1';
        }
    }
    function updateTilingOptions(width, height) {
        const MIN_TILE_SIZE = 16;
        const MAX_TILE_SIZE = 640;
        let options = new Map();
        const sizesToTry = [28,32, 64, 96, 128, 192, 256, 384, 512]; 
        for (const size of sizesToTry) {
            const cols = Math.max(1, Math.round(width / size));
            const rows = Math.max(1, Math.round(height / size));
            const tileW = Math.ceil(width / cols);
            const tileH = Math.ceil(height / rows);
            if (tileW >= MIN_TILE_SIZE && tileH >= MIN_TILE_SIZE && tileW <= MAX_TILE_SIZE && tileH <= MAX_TILE_SIZE) {
                const key = `${cols}x${rows}`;
                if (!options.has(key)) {
                    options.set(key, { cols, rows, tileSize: `${tileW}×${tileH}` });
                }
            }
        }
        if (!options.has('1x1')) {
            options.set('1x1', { cols: 1, rows: 1, tileSize: `${width}×${height}` });
        }
        tilingOptions = Array.from(options.values()).sort((a, b) => (b.cols * b.rows) - (a.cols * a.rows));
        let defaultIndex = tilingOptions.findIndex(opt => {
             const [w, h] = opt.tileSize.split('×').map(Number);
             return w >= 30 && h >= 30;
        });
        if (defaultIndex === -1) defaultIndex = 0;
        tilingSlider.max = tilingOptions.length - 1;
        tilingSlider.value = defaultIndex;
    }
    function updateTilingInfoText() {
        if (tilingOptions.length > 0) {
            const selectedOption = tilingOptions[tilingSlider.value];
            if (selectedOption) {
                tilingValue.textContent = selectedOption.tileSize;
                tilingInfo.textContent = `将分割成 ${selectedOption.cols * selectedOption.rows} 块`;
            }
        } else {
            tilingValue.textContent = '自动';
            tilingInfo.textContent = '上传图片后将自动计算分割方案。';
        }
    }

    loadSettings();
    initializeWorker();
    toggleWaifu2xOptions();
    memorySlider.dispatchEvent(new Event('input'));
    
});