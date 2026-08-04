package main

import (
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
	"time"
)

func main() {
	coreURL := env("CORE_URL", "http://127.0.0.1:8080")
	customerURL := env("CUSTOMER_URL", "")
	addr := env("HTTP_ADDR", ":3000")
	uiDir := env("UI_DIR", "ui")

	coreProxy := mustProxy(coreURL)
	var customerProxy *httputil.ReverseProxy
	if customerURL != "" {
		customerProxy = mustProxy(customerURL)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok","service":"zakupki-gateway"}`))
	})

	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		if customerProxy != nil && isCustomerPath(r.URL.Path) {
			customerProxy.ServeHTTP(w, r)
			return
		}
		coreProxy.ServeHTTP(w, r)
	})

	fs := http.FileServer(http.Dir(uiDir))
	mux.Handle("/", spaFallback(uiDir, fs))

	srv := &http.Server{Addr: addr, Handler: withCORS(mux), ReadHeaderTimeout: 10 * time.Second}
	log.Printf("zakupki-gateway on %s (core=%s customer=%s)", addr, coreURL, customerURL)
	log.Fatal(srv.ListenAndServe())
}

func isCustomerPath(p string) bool {
	return strings.Contains(p, "/courts") || strings.Contains(p, "/rnp") ||
		strings.Contains(p, "/fns") || strings.Contains(p, "/fas")
}

func spaFallback(uiDir string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" || r.URL.Path == "/index.html" {
			http.ServeFile(w, r, uiDir+"/index.html")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func mustProxy(raw string) *httputil.ReverseProxy {
	u, err := url.Parse(raw)
	if err != nil {
		log.Fatalf("bad proxy url %q: %v", raw, err)
	}
	p := httputil.NewSingleHostReverseProxy(u)
	// AI-анализ (несколько LLM-вызовов) может идти минутами — не рвём upstream рано.
	p.Transport = &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		ResponseHeaderTimeout: 20 * time.Minute,
		IdleConnTimeout:       90 * time.Second,
	}
	orig := p.Director
	p.Director = func(r *http.Request) {
		orig(r)
		r.Host = u.Host
	}
	p.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		http.Error(w, "upstream: "+err.Error(), http.StatusBadGateway)
	}
	return p
}

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
