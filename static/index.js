var lastPageId = document.getElementById("c-page-id").value;

setInterval(() => {
    if (document.getElementById("c-page-id").value !== lastPageId) {
        lastPageId = document.getElementById("c-page-id").value;
        
        changePageDynFunc(lastPageId);
    }
}, 25);