document.addEventListener('DOMContentLoaded', () => {
    console.log("AI Upscaler Studio (ONNX Version) Loaded");

    // --- DOM元素获取 ---
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
    const patchSizeSlider = document.getElementById('patchSizeSlider');
    const patchSizeValue = document.getElementById('patchSizeValue');
    const patchSizeInfo = document.getElementById('patchSizeInfo');
    const previewControls = document.getElementById('previewControls');
    const zoomSlider = document.getElementById('zoomSlider');
    const zoomValue = document.getElementById('zoomValue');
    const waifu2xArch = document.getElementById('waifu2x-arch');
    const waifu2xStyle = document.getElementById('waifu2x-style');
    const waifu2xNoise = document.getElementById('waifu2x-noise');
    const waifu2xScale = document.getElementById('waifu2x-scale');

    // --- 全局状态和配置 ---
    const PATCH_SIZES = [16, 32, 48, 64, 96, 128, 192, 256, 384];
    const PATCH_INFO = [
        "极低内存，极慢。用于内存极小的设备。", "非常低内存，非常慢。适合处理超大图片。", "低内存，较慢。", "中低内存，速度尚可。", "默认值。内存与速度的良好平衡。", "中高内存，速度快。推荐。", "高内存，速度很快。", "非常高内存，可能导致浏览器卡顿。", "实验性。极易导致浏览器崩溃。"
    ];
    let upscalerWorker;
    let originalFile = null;

    // --- 核心功能函数 ---
    function initializeWorker() {
        if (typeof(Worker) === "undefined") {
            alert('抱歉，您的浏览器不支持Web Workers，无法使用此应用。');
            statusDiv.innerHTML = '<i class="fas fa-times-circle"></i> 初始化失败';
            return;
        }
        statusDiv.innerHTML = '<i class="fas fa-cogs"></i> 正在初始化AI环境...';
        upscalerWorker = new Worker('upscaler-worker.js');
        upscalerWorker.onmessage = handleWorkerMessage;
        upscalerWorker.onerror = (e) => {
             console.error(`Worker error: ${e.message}`, e);
             statusDiv.innerHTML = `<i class="fas fa-times-circle"></i> Worker遇到严重错误: ${e.message}`;
             enableControls();
        }
    }

    function handleWorkerMessage(event) {
        const { type, payload } = event.data;
        switch (type) {
            case 'status':
                statusDiv.innerHTML = `<i class="fas fa-info-circle"></i> ${payload.message}`;
                break;
            // 【新增】处理模型下载进度的逻辑
            case 'download_progress':
                const percentage = Math.round(payload.progress * 100);
                statusDiv.innerHTML = `<i class="fas fa-cloud-download-alt fa-spin"></i> 正在下载模型 (${payload.file}): ${percentage}%`;
                break;
            case 'progress':
                updateProgress(payload.progress, payload.eta, payload.task);
                break;
            case 'done':
                renderUpscaledImage(payload);
                break;
            case 'error':
                // 现在 payload.message 会有正确的错误信息
                console.error("Worker Error:", payload);
                statusDiv.innerHTML = `<i class="fas fa-times-circle"></i> 处理失败: ${payload.message}`;
                enableControls();
                break;
        }
    }

    async function renderUpscaledImage(imageData) {
        statusDiv.innerHTML = '<i class="fas fa-check-circle"></i> 处理完成！正在渲染图片...';
        await new Promise(resolve => setTimeout(resolve, 50));
    
        const { width, height, data } = imageData;
        resultInfo.textContent = `${width}×${height} • ${(width * height / 1000000).toFixed(2)} MP`;
        
        const canvasZoomContainer = document.getElementById('canvasZoomContainer'); 
        canvasZoomContainer.style.width = `${width}px`;
        canvasZoomContainer.style.height = `${height}px`;
    
        resultCanvas.width = width;
        resultCanvas.height = height;
        resultCanvas.style.width = `${width}px`;
        resultCanvas.style.height = `${height}px`;
    
        const ctx = resultCanvas.getContext('2d');
        const clampedData = new Uint8ClampedArray(data);
        ctx.putImageData(new ImageData(clampedData, width, height), 0, 0);
    
        resultContainer.style.display = 'flex';
        previewControls.style.display = 'block';
        downloadBtn.style.display = 'flex';
        
        zoomSlider.value = 100;
        zoomValue.textContent = '100%';
        resultCanvas.style.transform = 'scale(1)';
    
        statusDiv.innerHTML = '<i class="fas fa-check-circle"></i> 预览或下载图片';
        enableControls();
    }

    function handleImageUpload(file) {
        if (!file) return;
        originalFile = file;

        const reader = new FileReader();
        reader.onload = (e) => {
            const imageDataUrl = e.target.result;
            const img = new Image();
            img.onload = () => {
                const sizeInMB = (file.size / 1024 / 1024).toFixed(2);
                originalInfo.textContent = `${img.width}×${img.height} • ${sizeInMB} MB`;
            };
            img.src = imageDataUrl;

            resultContainer.style.display = 'none';
            previewControls.style.display = 'none';
            downloadBtn.style.display = 'none';

            originalImageBox.style.display = 'flex';
            originalImage.src = imageDataUrl;
            
            executeBtn.style.display = 'flex';
            statusDiv.innerHTML = '<i class="fas fa-image"></i> 图片已加载，点击 "执行" 开始处理';
            enableControls();
        };
        reader.readAsDataURL(file);
    }
    
    function executeUpscale() {
        if (!originalFile) {
            alert('请先上传一张图片！');
            return;
        }
        disableControls();
        
        const config = {
            patchSize: PATCH_SIZES[patchSizeSlider.valueAsNumber],
            waifu2x: {
                arch: waifu2xArch.value,
                style: waifu2xStyle.value,
                noise: waifu2xNoise.value,
                scale: parseInt(waifu2xScale.value, 10),
            }
        };

        statusDiv.innerHTML = '<i class="fas fa-paper-plane"></i> 任务已发送，请稍候...';
        upscalerWorker.postMessage({ type: 'start', file: originalFile, config: config });
    }

    function updateProgress(progress, eta, task) {
        const percentage = Math.round(progress * 100);
        let etaText = '';
        if (eta > 0) {
            const minutes = Math.floor(eta / 60);
            const seconds = Math.round(eta % 60);
            etaText = ` (预计剩余 ${minutes}分 ${seconds.toString().padStart(2, '0')}秒)`;
        } else if (percentage > 98) {
             etaText = " (即将完成...)";
        }
        
        const taskText = task ? `[${task}] ` : '';
        statusDiv.innerHTML = `<i class="fas fa-spinner fa-spin"></i> ${taskText}处理中... ${percentage}%${etaText}`;
    }

    function disableControls() {
        uploadArea.style.pointerEvents = 'none';
        uploadArea.style.opacity = 0.6;
        waifu2xArch.disabled = true;
        waifu2xStyle.disabled = true;
        waifu2xNoise.disabled = true;
        waifu2xScale.disabled = true;
        patchSizeSlider.disabled = true;
        executeBtn.disabled = true;
        downloadBtn.style.display = 'none';
    }

    function enableControls() {
        uploadArea.style.pointerEvents = 'auto';
        uploadArea.style.opacity = 1;
        waifu2xArch.disabled = false;
        patchSizeSlider.disabled = false;
        executeBtn.disabled = false;
        // Do not clear file input here to allow re-running on the same file
        toggleWaifu2xOptions();
    }
    
    function toggleWaifu2xOptions() {
        const arch = waifu2xArch.value;
        const isCunet = arch === 'cunet';
        
        waifu2xStyle.disabled = isCunet;
        const styleGroup = waifu2xStyle.closest('.form-group');
        if (styleGroup) {
             styleGroup.style.opacity = isCunet ? 0.5 : 1;
             styleGroup.style.pointerEvents = isCunet ? 'none' : 'auto';
        }

        const scaleOptions = Array.from(waifu2xScale.options);
        scaleOptions.forEach(opt => {
            if (parseInt(opt.value, 10) > 2) {
                opt.disabled = isCunet;
            } else {
                opt.disabled = false;
            }
        });

        if (isCunet && waifu2xScale.value !== '2') {
            waifu2xScale.value = '2';
        }
    }

    // --- 事件绑定 ---
    uploadArea.addEventListener('click', () => fileInput.click());
    
    fileInput.addEventListener('change', (event) => {
        const file = event.target.files[0];
        if (file) {
            handleImageUpload(file);
        }
    });

    ['dragover', 'drop'].forEach(eventName => {
        uploadArea.addEventListener(eventName, e => { e.preventDefault(); e.stopPropagation(); });
    });
    uploadArea.addEventListener('dragenter', () => uploadArea.classList.add('dragging'));
    uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('dragging'));

    uploadArea.addEventListener('drop', (e) => {
        uploadArea.classList.remove('dragging');
        const file = e.dataTransfer.files[0];
        if (file && file.type.startsWith('image/')) {
            handleImageUpload(file);
        }
    });
    
    executeBtn.addEventListener('click', executeUpscale);

    patchSizeSlider.addEventListener('input', () => {
        const index = patchSizeSlider.valueAsNumber;
        patchSizeValue.textContent = PATCH_SIZES[index] + 'px';
        patchSizeInfo.textContent = PATCH_INFO[index];
    });

    waifu2xArch.addEventListener('change', toggleWaifu2xOptions);

    zoomSlider.addEventListener('input', () => {
        const scale = zoomSlider.value / 100;
        zoomValue.textContent = zoomSlider.value + '%';
        resultCanvas.style.transform = `scale(${scale})`;
    });

    downloadBtn.addEventListener('click', () => {
        if (!resultCanvas || resultCanvas.width === 0) {
            statusDiv.innerHTML = '<i class="fas fa-times-circle"></i> 下载失败，没有可用的图像！';
            return;
        }
        
        const link = document.createElement('a');
        link.href = resultCanvas.toDataURL('image/png');
        const fileName = originalFile ? originalFile.name.split('.').slice(0, -1).join('.') : 'enhanced';
        link.download = `${fileName}-waifu2x-${waifu2xArch.value}-${Date.now()}.png`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        
        statusDiv.innerHTML = '<i class="fas fa-check-circle"></i> 图片下载成功！';
    });

    // --- 初始启动 ---
    initializeWorker();
    toggleWaifu2xOptions();
    patchSizeValue.textContent = PATCH_SIZES[patchSizeSlider.valueAsNumber] + 'px';
    patchSizeInfo.textContent = PATCH_INFO[patchSizeSlider.valueAsNumber];
});