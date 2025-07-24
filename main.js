document.addEventListener('DOMContentLoaded', () => {
    console.log("AI Upscaler Studio (Refactored) Loaded");

    // --- DOM元素获取 ---
    const modelSelect = document.getElementById('modelSelect');
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
    const waifu2xSettings = document.getElementById('waifu2x-settings');
    const waifu2xArch = document.getElementById('waifu2x-arch');
    const waifu2xStyle = document.getElementById('waifu2x-style');
    const waifu2xNoise = document.getElementById('waifu2x-noise');
    const waifu2xScale = document.getElementById('waifu2x-scale');

    // --- 全局状态和配置 ---
    const PATCH_SIZES = [4, 8, 16, 32, 64, 128, 256, 512, 1024];
    const PATCH_INFO = [
        "极低内存，极慢速度。仅用于内存极小的设备。", "非常低内存，非常慢。适合处理超大图片。", "低内存，较慢。适合内存受限的环境。", "中低内存，速度尚可。一个安全的选择。", "默认值。内存占用和处理速度的良好平衡。", "中高内存，速度快。推荐给性能较好的电脑。", "高内存，速度很快。需要较好的硬件支持。", "非常高内存，接近极限。可能导致浏览器卡顿。", "实验性。极易导致浏览器崩溃，请谨慎使用。"
    ];
    let upscalerWorker;
    let originalImageDataUrl = null;

    // [MODIFIED] 设置默认模型
    modelSelect.value = 'div2k-2x'; 

    // --- 核心功能函数 ---
    function initializeWorker() {
        if (window.Worker) {
            statusDiv.innerHTML = '<i class="fas fa-cogs"></i> 正在初始化AI环境...';
            upscalerWorker = new Worker('upscaler-worker.js');
            upscalerWorker.onmessage = handleWorkerMessage;
        } else {
            alert('您的浏览器不支持Web Workers，无法使用此应用。');
            statusDiv.innerHTML = '<i class="fas fa-times-circle"></i> 初始化失败';
        }
    }

    function handleWorkerMessage(event) {
        const { type, data, payload } = event.data;
        switch (type) {
            case 'STATUS':
                statusDiv.innerHTML = `<i class="fas fa-info-circle"></i> ${data}`;
                break;
            case 'PROGRESS':
                updateCountdown(data.startTime, data.ratio);
                break;
            case 'DONE':
                renderUpscaledImage(payload);
                break;
            case 'ERROR':
                console.error("Worker Error:", data);
                statusDiv.innerHTML = `<i class="fas fa-times-circle"></i> 处理失败: ${data}`;
                enableControls();
                break;
        }
    }

    async function renderUpscaledImage(payload) {
        const { data, width, height } = payload;
    
        statusDiv.innerHTML = '<i class="fas fa-check-circle"></i> 处理完成！正在渲染图片...';
        await new Promise(resolve => setTimeout(resolve, 50));
    
        resultInfo.textContent = `${width}×${height} • ${Math.round(width * height / 1000000 * 10) / 10}MP`;
        
        // 我们暂时保留之前的修复逻辑，因为如果尺寸是对的，它们仍然是必要的
        const canvasZoomContainer = document.getElementById('canvasZoomContainer'); 
        if (canvasZoomContainer) {
            canvasZoomContainer.style.width = `${width}px`;
            canvasZoomContainer.style.height = `${height}px`;
        }
    
        resultCanvas.width = width;
        resultCanvas.height = height;
        resultCanvas.style.width = `${width}px`;
        resultCanvas.style.height = `${height}px`;
    
        const ctx = resultCanvas.getContext('2d');
        const imageData = new ImageData(new Uint8ClampedArray(data), width, height);
        ctx.putImageData(imageData, 0, 0);
    
        resultContainer.style.display = 'flex';
        previewControls.style.display = 'block';
        downloadBtn.style.display = 'flex';
        
        zoomSlider.value = 100;
        zoomValue.textContent = '100%';
        resultCanvas.style.transform = 'scale(1)';
    
        statusDiv.innerHTML = '<i class="fas fa-check-circle"></i> 可以预览或下载图片了';
        enableControls();
    }

    function handleImageUpload(imageDataUrl, file) {
        if (!imageDataUrl) return;

        originalImageDataUrl = imageDataUrl;
        
        if (file) {
            const sizeInMB = (file.size / 1024 / 1024).toFixed(2);
            originalInfo.textContent = `${file.name} • ${sizeInMB} MB`;
        } else {
            originalInfo.textContent = `来自插件的图片`;
        }

        // 重置旧结果
        resultContainer.style.display = 'none';
        previewControls.style.display = 'none';
        downloadBtn.style.display = 'none';

        originalImageBox.style.display = 'flex';
        originalImage.src = originalImageDataUrl;
        
        // 显示执行按钮
        executeBtn.style.display = 'flex';
        statusDiv.innerHTML = '<i class="fas fa-image"></i> 图片已加载，请点击"执行放大"';
        enableControls();
    }
    
    function executeUpscale() {
        if (!originalImageDataUrl) {
            alert('请先上传一张图片！');
            return;
        }
        disableControls();
        
        const modelId = modelSelect.value;
        const payload = {
            imageDataUrl: originalImageDataUrl,
            modelId: modelId,
            patchSize: PATCH_SIZES[patchSizeSlider.valueAsNumber]
        };

        if (modelId === 'waifu2x') {
            payload.waifu2x_config = {
                arch: waifu2xArch.value,
                style: waifu2xStyle.value,
                noise: waifu2xNoise.value,
                scale: waifu2xScale.value
            };
        }
        
        statusDiv.innerHTML = '<i class="fas fa-paper-plane"></i> 已发送到AI Worker，请稍候...';
        upscalerWorker.postMessage({ type: 'UPSCALE', payload });
    }

    function updateCountdown(startTime, progress) {
        const percentage = Math.round(progress * 100);
        if (startTime === 0 || progress < 0.02) {
            statusDiv.innerHTML = `<i class="fas fa-spinner fa-spin"></i> 处理中... ${percentage}% (正在准备计算...)`;
            return;
        }
        const elapsed = Date.now() - startTime;
        const estimatedTotal = elapsed / progress;
        const remaining = Math.round((estimatedTotal - elapsed) / 1000);
        if (remaining < 1) {
             statusDiv.innerHTML = `<i class="fas fa-spinner fa-spin"></i> 处理中... ${percentage}% (即将完成...)`;
             return;
        }
        const minutes = Math.floor(remaining / 60);
        const seconds = remaining % 60;
        statusDiv.innerHTML = `<i class="fas fa-spinner fa-spin"></i> 处理中... ${percentage}% (预计剩余 ${minutes}分 ${seconds.toString().padStart(2, '0')}秒)`;
    }

    function disableControls() {
        uploadArea.style.pointerEvents = 'none';
        uploadArea.style.opacity = 0.6;
        modelSelect.disabled = true;
        patchSizeSlider.disabled = true;
        executeBtn.disabled = true;
        downloadBtn.disabled = true;
    }

    function enableControls() {
        uploadArea.style.pointerEvents = 'auto';
        uploadArea.style.opacity = 1;
        modelSelect.disabled = false;
        patchSizeSlider.disabled = false;
        executeBtn.disabled = false;
        downloadBtn.disabled = false;
        fileInput.value = '';
    }
    
    function toggleWaifu2xOptions() {
        const isWaifu2x = modelSelect.value === 'waifu2x';
        waifu2xSettings.style.display = isWaifu2x ? 'block' : 'none';

        if (!isWaifu2x) return;

        const arch = waifu2xArch.value;
        const isCunet = arch === 'cunet';
        const isSwinUnet = arch === 'swin_unet';
        
        if (waifu2xStyle.parentElement) {
            waifu2xStyle.parentElement.style.display = isCunet ? 'none' : '';
        }

        const scale4xOption = Array.from(waifu2xScale.options).find(opt => opt.value === '4');
        if (scale4xOption) {
            scale4xOption.disabled = !isSwinUnet;
            if (!isSwinUnet && waifu2xScale.value === '4') {
                waifu2xScale.value = '2';
            }
        }
    }

    // --- 事件绑定 ---
    uploadArea.addEventListener('click', () => fileInput.click());
    
    fileInput.addEventListener('change', (event) => {
        const file = event.target.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = (e) => handleImageUpload(e.target.result, file);
            reader.readAsDataURL(file);
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
        if (file && file.type.match('image.*')) {
            const reader = new FileReader();
            reader.onload = (e) => handleImageUpload(e.target.result, file);
            reader.readAsDataURL(file);
        }
    });
    
    executeBtn.addEventListener('click', executeUpscale);

    patchSizeSlider.addEventListener('input', () => {
        const index = patchSizeSlider.valueAsNumber;
        patchSizeValue.textContent = PATCH_SIZES[index] + 'px';
        patchSizeInfo.textContent = PATCH_INFO[index];
    });

    modelSelect.addEventListener('change', toggleWaifu2xOptions);
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
        link.download = `enhanced-image-${Date.now()}.png`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        
        statusDiv.innerHTML = '<i class="fas fa-check-circle"></i> 图片下载成功！';
    });

    // --- 初始启动 ---
    initializeWorker();
    toggleWaifu2xOptions();
});