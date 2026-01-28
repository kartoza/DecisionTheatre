package main

import (
	"flag"
	"fmt"
	"log"
	"net"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/kartoza/decision-theatre/internal/config"
	"github.com/kartoza/decision-theatre/internal/server"
	webview "github.com/webview/webview_go"
)

var version = "dev"

func main() {
	// Parse command-line flags
	port := flag.Int("port", 8080, "HTTP server port")
	dataDir := flag.String("data-dir", "./data", "Directory containing data files (mbtiles, geoparquet)")
	resourcesDir := flag.String("resources-dir", "./resources", "Directory containing resource files (mbtiles, styles)")
	modelPath := flag.String("model", "", "Path to GGUF model file for embedded LLM")
	headless := flag.Bool("headless", false, "Run in headless mode (no GUI window)")
	showVersion := flag.Bool("version", false, "Show version and exit")
	flag.Parse()

	if *showVersion {
		fmt.Printf("Decision Theatre v%s\n", version)
		os.Exit(0)
	}

	// Build configuration
	cfg := config.Config{
		Port:         *port,
		DataDir:      *dataDir,
		ResourcesDir: *resourcesDir,
		ModelPath:    *modelPath,
		Version:      version,
	}

	log.Printf("Decision Theatre v%s starting on port %d", version, cfg.Port)
	log.Printf("Data directory: %s", cfg.DataDir)

	// Create and start the server
	srv, err := server.New(cfg)
	if err != nil {
		log.Fatalf("Failed to create server: %v", err)
	}

	// Graceful shutdown on SIGINT/SIGTERM
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)

	// Start server in background
	errCh := make(chan error, 1)
	go func() {
		errCh <- srv.Start()
	}()

	// Wait for server to be ready
	serverURL := fmt.Sprintf("http://localhost:%d", cfg.Port)
	waitForServer(serverURL, 10*time.Second)

	if *headless {
		// Headless mode: wait for signal or error
		select {
		case err := <-errCh:
			if err != nil {
				log.Fatalf("Server error: %v", err)
			}
		case sig := <-stop:
			log.Printf("Received %v signal, shutting down...", sig)
			if err := srv.Stop(); err != nil {
				log.Printf("Error during shutdown: %v", err)
			}
		}
	} else {
		// GUI mode: open embedded WebView window
		log.Printf("Opening application window...")
		w := webview.New(false)
		defer w.Destroy()

		w.SetTitle("Decision Theatre")
		w.SetSize(1280, 800, webview.HintNone)
		w.Navigate(serverURL)

		// When the webview window closes, shut down the server
		go func() {
			select {
			case err := <-errCh:
				if err != nil {
					log.Printf("Server error: %v", err)
				}
			case sig := <-stop:
				log.Printf("Received %v signal, shutting down...", sig)
				w.Terminate()
			}
		}()

		// Run blocks until the window is closed
		w.Run()

		log.Printf("Window closed, shutting down server...")
		if err := srv.Stop(); err != nil {
			log.Printf("Error during shutdown: %v", err)
		}
	}
}

// waitForServer polls until the server is accepting connections
func waitForServer(url string, timeout time.Duration) {
	addr := url[len("http://"):]
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		conn, err := net.DialTimeout("tcp", addr, 500*time.Millisecond)
		if err == nil {
			conn.Close()
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	log.Printf("Warning: server may not be ready at %s", url)
}
