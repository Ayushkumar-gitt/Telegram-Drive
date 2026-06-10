import re

with open('src/pages/Dashboard.tsx', 'r') as f:
    content = f.read()

# We will replace from `return (` to the end of the Dashboard component.

# First, let's find the `return (` of the Dashboard component
split_idx = content.find('  return (\n    <div className="h-screen')

if split_idx == -1:
    print("Could not find start of return block")
    exit(1)

pre_return = content[:split_idx]

# Let's add our derived state before the return block
derived_state = """
  // Derived state for the redesign
  const recentFolders = useMemo(() => {
    return [...folders].filter(f => !f.isTrashed).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 3)
  }, [folders])

  const newFilesList = useMemo(() => {
    return [...files].filter(f => !f.isTrashed).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 4)
  }, [files])

  const sharedFilesList = useMemo(() => {
    // Just showing some files as "Shared" for UI purposes
    return [...files].filter(f => !f.isTrashed).slice(0, 6)
  }, [files])

"""

# Remove the old return block
end_idx = content.find('const CloudUploadIcon')
if end_idx == -1:
    print("Could not find CloudUploadIcon")
    exit(1)

post_dashboard = content[end_idx:]

new_return = """  return (
    <div className="h-screen flex bg-[#0A0D14] text-white font-sans overflow-hidden">
      
      {/* ── Left Sidebar ── */}
      <aside className="w-64 bg-[#0A0D14] border-r border-white/5 flex flex-col flex-shrink-0">
        <div className="p-6">
          <h1 className="text-2xl font-bold tracking-tighter text-[#5A62FB] flex items-center gap-2">
            <Cloud className="w-6 h-6" />
            cloud.
          </h1>
        </div>

        <div className="flex-1 overflow-y-auto px-4 pb-4 no-scrollbar">
          <div className="mb-6">
            <button 
              onClick={() => { setActiveTab('files'); setCurrentFolderId(null) }}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all ${activeTab === 'files' && !currentFolderId ? 'text-[#5A62FB] bg-[#5A62FB]/10 font-medium' : 'text-neutral-400 hover:text-white hover:bg-white/5'}`}
            >
              <LayoutGrid className="w-5 h-5" />
              My drive
            </button>
          </div>

          <div className="mb-6">
            <p className="px-4 text-xs font-bold text-neutral-500 tracking-wider mb-2">FILES</p>
            <div className="space-y-1">
              <button onClick={() => { setActiveTab('files'); setCurrentFolderId(null) }} className={`w-full flex items-center gap-3 px-4 py-2.5 rounded-xl transition-colors ${activeTab === 'files' && !currentFolderId ? 'text-white bg-white/5 font-medium' : 'text-neutral-400 hover:text-white hover:bg-white/5'}`}><FolderIcon className="w-4 h-4" /> My files</button>
              <button onClick={() => setActiveTab('gallery')} className={`w-full flex items-center gap-3 px-4 py-2.5 rounded-xl transition-colors ${activeTab === 'gallery' ? 'text-white bg-white/5 font-medium' : 'text-neutral-400 hover:text-white hover:bg-white/5'}`}><ImageIcon className="w-4 h-4" /> Gallery</button>
              <button onClick={() => setActiveTab('trash')} className={`w-full flex items-center gap-3 px-4 py-2.5 rounded-xl transition-colors ${activeTab === 'trash' ? 'text-white bg-white/5 font-medium' : 'text-neutral-400 hover:text-white hover:bg-white/5'}`}><Trash className="w-4 h-4" /> Deleted files</button>
              <button onClick={() => setActiveTab('stats')} className={`w-full flex items-center gap-3 px-4 py-2.5 rounded-xl transition-colors ${activeTab === 'stats' ? 'text-white bg-white/5 font-medium' : 'text-neutral-400 hover:text-white hover:bg-white/5'}`}><BarChart3 className="w-4 h-4" /> Storage Stats</button>
            </div>
          </div>

          <div>
            <p className="px-4 text-xs font-bold text-neutral-500 tracking-wider mb-2 flex items-center justify-between">
              MY PLACES
              <button onClick={() => setIsCreatingFolder(true)} className="hover:text-white transition-colors"><Plus className="w-3.5 h-3.5" /></button>
            </p>
            <div className="space-y-1">
              {folders.filter(f => !f.isTrashed).map(folder => (
                <button 
                  key={folder.id}
                  onClick={() => { setActiveTab('files'); setCurrentFolderId(folder.id) }}
                  className={`w-full flex items-center gap-3 px-4 py-2.5 rounded-xl transition-colors truncate ${currentFolderId === folder.id ? 'text-white bg-white/5 font-medium' : 'text-neutral-400 hover:text-white hover:bg-white/5'}`}
                >
                  <FolderIcon className="w-4 h-4 flex-shrink-0" /> 
                  <span className="truncate text-sm">{folder.name}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="p-4 mt-auto border-t border-white/5">
          <div className="flex items-center gap-3 px-2 py-2">
            <div className="w-10 h-10 rounded-full bg-gradient-to-tr from-[#5A62FB] to-purple-500 flex items-center justify-center text-white font-bold flex-shrink-0 shadow-lg">
              {userId ? userId.charAt(0).toUpperCase() : 'U'}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold truncate text-white">{userId || 'User'}</p>
              <button onClick={handleLogout} className="text-xs text-neutral-500 hover:text-red-400 transition-colors">Logout</button>
            </div>
          </div>
        </div>
      </aside>

      {/* ── Main Content Area ── */}
      <main className="flex-1 flex flex-col overflow-hidden bg-[#11141D] rounded-tl-3xl shadow-2xl relative">
        
        {/* Top Header Row */}
        <div className="flex items-center justify-between p-8 pb-4">
          <div className="flex items-center gap-3 text-neutral-500">
            <button onClick={() => setCurrentFolderId(null)} className={`p-1.5 rounded-lg transition-colors ${currentFolderId ? 'hover:bg-white/10 text-white' : 'opacity-50 cursor-not-allowed'}`}>
              <ArrowLeft className="w-5 h-5" />
            </button>
          </div>
          
          <div className="flex items-center gap-4">
            <button 
              onClick={() => document.getElementById('global-file-input')?.click()}
              className="px-6 py-2.5 bg-[#5A62FB] hover:bg-[#4d54d6] text-white text-sm font-medium rounded-full shadow-[0_0_15px_rgba(90,98,251,0.3)] transition-all active:scale-95 whitespace-nowrap"
            >
              UPLOAD NEW FILE
            </button>
            
            <div className="relative w-64 hidden md:block">
              <input
                type="text"
                placeholder="Search your content"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full bg-[#1A1D27] text-sm text-white placeholder-neutral-500 rounded-full pl-5 pr-10 py-2.5 outline-none focus:ring-1 focus:ring-[#5A62FB] transition-all"
              />
              <button className="absolute right-1 top-1 p-1.5 bg-[#5A62FB] rounded-full text-white">
                <Search className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>

        {/* Dynamic Content Area based on Tab & State */}
        <div className="flex-1 overflow-y-auto px-8 pb-8 no-scrollbar">
          
          {activeTab === 'files' && !currentFolderId && !searchQuery ? (
            /* ── Redesigned Dashboard Root View ── */
            <div className="space-y-10 animate-in fade-in duration-500">
              
              {/* Recently Used (Folders) */}
              {recentFolders.length > 0 && (
                <section>
                  <h2 className="text-lg font-semibold mb-4 text-white/90">Recently used</h2>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    {recentFolders.map((folder, idx) => (
                      <div 
                        key={folder.id} 
                        onClick={() => setCurrentFolderId(folder.id)}
                        className={`p-6 rounded-3xl cursor-pointer transition-transform hover:scale-[1.02] active:scale-[0.98] ${idx === 0 ? 'bg-[#5A62FB] text-white shadow-[0_8px_30px_rgba(90,98,251,0.2)]' : 'bg-[#1A1D27] text-white hover:bg-[#202430]'}`}
                      >
                        <div className="flex justify-between items-start mb-8">
                          <FolderIcon className={`w-8 h-8 ${idx === 0 ? 'text-white' : 'text-[#5A62FB]'}`} fill="currentColor" fillOpacity={idx === 0 ? 0.2 : 0.1} />
                        </div>
                        <p className={`text-xs font-semibold mb-1 tracking-wider ${idx === 0 ? 'text-white/60' : 'text-neutral-500'}`}>FOLDER</p>
                        <h3 className="text-xl font-semibold truncate">{folder.name}</h3>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {/* New Files List */}
              {newFilesList.length > 0 && (
                <section>
                  <div className="flex justify-between items-center mb-4">
                    <h2 className="text-lg font-semibold text-white/90">New files</h2>
                  </div>
                  <div className="bg-[#1A1D27] rounded-3xl overflow-hidden">
                    {newFilesList.map((file, i) => (
                      <div 
                        key={file.id} 
                        onClick={() => setViewingFile(file)}
                        className={`grid grid-cols-[auto_1fr_100px_120px_80px_auto] gap-4 items-center px-6 py-4 cursor-pointer hover:bg-[#202430] transition-colors ${i !== newFilesList.length - 1 ? 'border-b border-white/5' : ''}`}
                      >
                        <div className="w-10 h-10 rounded-xl bg-white/5 flex items-center justify-center flex-shrink-0">
                          {getFileIcon(file)}
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate text-white">{file.name}</p>
                        </div>
                        <div className="text-sm text-neutral-500 hidden sm:block truncate">
                          {file.mimeType.split('/')[1] || 'Unknown'}
                        </div>
                        <div className="text-sm text-neutral-500 hidden md:block">
                          {file.createdAt ? format(new Date(file.createdAt), 'dd.MM.yyyy') : '--'}
                        </div>
                        <div className="text-xs font-semibold px-2 py-1 rounded bg-white/5 text-neutral-400 hidden lg:block text-center truncate">
                          .{file.name.split('.').pop()?.toLowerCase() || 'file'}
                        </div>
                        <div className="flex items-center gap-1 opacity-0 hover:opacity-100 transition-opacity" style={{ opacity: 1 /* Always visible on hover not working inline easily, using group */ }}>
                           {/* Using standard buttons for actions */}
                           <button onClick={(e) => { e.stopPropagation(); handleDownload(file) }} className="p-1.5 text-neutral-400 hover:text-white transition-colors"><DownloadIcon className="w-4 h-4" /></button>
                           <button onClick={(e) => { e.stopPropagation(); handleShare(file) }} className="p-1.5 text-neutral-400 hover:text-white transition-colors"><Share2 className="w-4 h-4" /></button>
                           <button onClick={(e) => { e.stopPropagation(); handleDelete(file, false) }} className="p-1.5 text-neutral-400 hover:text-red-400 transition-colors"><TrashIcon className="w-4 h-4" /></button>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {/* Shared with me (Grid) */}
              {sharedFilesList.length > 0 && (
                <section>
                  <div className="flex justify-between items-center mb-4">
                    <h2 className="text-lg font-semibold text-white/90">Shared with me</h2>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
                    {sharedFilesList.map(file => (
                      <div 
                        key={file.id} 
                        onClick={() => setViewingFile(file)}
                        className="bg-[#1A1D27] p-4 rounded-2xl cursor-pointer hover:bg-[#202430] transition-colors flex flex-col items-center justify-center aspect-square group relative"
                      >
                         <div className="w-12 h-12 mb-3 rounded-xl bg-white/5 flex items-center justify-center text-neutral-400">
                           {getFileIcon(file)}
                         </div>
                         <p className="text-xs font-medium text-center truncate w-full text-neutral-300">{file.name}</p>
                         
                         <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity rounded-2xl flex items-center justify-center gap-2">
                           <button onClick={(e) => { e.stopPropagation(); handleDownload(file) }} className="p-1.5 bg-white/10 text-white rounded-lg hover:bg-white/20"><DownloadIcon className="w-4 h-4" /></button>
                           <button onClick={(e) => { e.stopPropagation(); handleShare(file) }} className="p-1.5 bg-white/10 text-white rounded-lg hover:bg-white/20"><Share2 className="w-4 h-4" /></button>
                         </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </div>
          ) : activeTab === 'files' ? (
            /* ── Folder Contents / Search Results ── */
            <div className="animate-in fade-in">
              <div className="flex justify-between items-center mb-6">
                <h2 className="text-xl font-bold">
                  {searchQuery ? 'Search Results' : (currentFolderId ? folders.find(f => f.id === currentFolderId)?.name : 'My files')}
                </h2>
                <div className="flex gap-2">
                  <button onClick={() => setViewMode('grid')} className={`p-2 rounded-lg transition-colors ${viewMode === 'grid' ? 'bg-[#5A62FB] text-white' : 'bg-white/5 text-neutral-400 hover:text-white'}`}><LayoutGrid className="w-4 h-4" /></button>
                  <button onClick={() => setViewMode('list')} className={`p-2 rounded-lg transition-colors ${viewMode === 'list' ? 'bg-[#5A62FB] text-white' : 'bg-white/5 text-neutral-400 hover:text-white'}`}><ListIcon className="w-4 h-4" /></button>
                </div>
              </div>
              
              {items.length === 0 ? (
                <div className="flex flex-col items-center justify-center text-neutral-500 py-20">
                  <FolderIcon className="w-16 h-16 opacity-20 mb-4" />
                  <p>Nothing here yet</p>
                </div>
              ) : viewMode === 'list' ? (
                <div className="bg-[#1A1D27] rounded-2xl overflow-hidden">
                  <div className="grid grid-cols-[auto_1fr_100px_150px_auto] gap-4 px-6 py-3 text-xs font-semibold text-neutral-500 uppercase tracking-wider border-b border-white/5">
                    <div className="w-5"></div>
                    <div>Name</div>
                    <div>Size</div>
                    <div>Date</div>
                    <div></div>
                  </div>
                  {items.map(item => {
                    const isFolder = item.type === 'folder'
                    return (
                      <div 
                        key={item.id}
                        onClick={() => isFolder ? setCurrentFolderId(item.id) : setViewingFile(item as TGFile)}
                        className="grid grid-cols-[auto_1fr_100px_150px_auto] gap-4 items-center px-6 py-3 border-b border-white/5 hover:bg-[#202430] transition-colors cursor-pointer group"
                      >
                         <div className="w-5">
                            {isFolder ? <FolderIcon className="w-5 h-5 text-neutral-400" /> : getFileIcon(item as TGFile)}
                         </div>
                         <div className="truncate font-medium text-sm text-white/90">{item.name}</div>
                         <div className="text-sm text-neutral-500">{isFolder ? '--' : filesize((item as TGFile).size)}</div>
                         <div className="text-sm text-neutral-500">{item.createdAt ? format(new Date(item.createdAt), 'dd.MM.yyyy') : '--'}</div>
                         <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                            {!isFolder && <button onClick={(e) => { e.stopPropagation(); handleDownload(item as TGFile) }} className="p-1.5 text-neutral-400 hover:text-white"><DownloadIcon className="w-4 h-4" /></button>}
                            {!isFolder && <button onClick={(e) => { e.stopPropagation(); handleShare(item as TGFile) }} className="p-1.5 text-neutral-400 hover:text-white"><Share2 className="w-4 h-4" /></button>}
                            <button onClick={(e) => { e.stopPropagation(); handleDelete(item, isFolder) }} className="p-1.5 text-neutral-400 hover:text-red-400"><TrashIcon className="w-4 h-4" /></button>
                         </div>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
                  {items.map(item => {
                    const isFolder = item.type === 'folder'
                    return (
                      <div 
                        key={item.id}
                        onClick={() => isFolder ? setCurrentFolderId(item.id) : setViewingFile(item as TGFile)}
                        className="bg-[#1A1D27] p-4 rounded-2xl cursor-pointer hover:bg-[#202430] transition-colors flex flex-col items-center justify-center aspect-square group relative border border-transparent hover:border-white/5"
                      >
                         <div className="w-12 h-12 mb-3 rounded-xl bg-white/5 flex items-center justify-center text-neutral-400">
                           {isFolder ? <FolderIcon className="w-6 h-6" /> : getFileIcon(item as TGFile)}
                         </div>
                         <p className="text-xs font-medium text-center truncate w-full text-neutral-300">{item.name}</p>
                         
                         <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity rounded-2xl flex flex-col items-center justify-center gap-2">
                           <div className="flex gap-2">
                             {!isFolder && <button onClick={(e) => { e.stopPropagation(); handleDownload(item as TGFile) }} className="p-2 bg-white/10 text-white rounded-lg hover:bg-white/20"><DownloadIcon className="w-4 h-4" /></button>}
                             {!isFolder && <button onClick={(e) => { e.stopPropagation(); handleShare(item as TGFile) }} className="p-2 bg-white/10 text-white rounded-lg hover:bg-white/20"><Share2 className="w-4 h-4" /></button>}
                           </div>
                           <button onClick={(e) => { e.stopPropagation(); handleDelete(item, isFolder) }} className="p-2 bg-red-500/20 text-red-400 rounded-lg hover:bg-red-500/40"><TrashIcon className="w-4 h-4" /></button>
                         </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          ) : activeTab === 'gallery' ? (
             <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
              {mediaFiles.length === 0 ? (
                <div className="col-span-full flex flex-col items-center justify-center text-neutral-500 py-20">
                  <ImageIcon className="w-16 h-16 opacity-20 mb-4" />
                  <p>No media files found</p>
                </div>
              ) : (
                mediaFiles.map((file) => (
                  <div key={file.id} onClick={() => setViewingFile(file)} className="aspect-square bg-[#1A1D27] rounded-2xl overflow-hidden cursor-pointer hover:ring-2 hover:ring-[#5A62FB] transition-all relative group">
                    <Thumbnail file={file} className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity" />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex flex-col justify-end p-3">
                      <p className="text-white text-xs truncate mb-2">{file.name}</p>
                      <div className="flex gap-2">
                        <button onClick={(e) => { e.stopPropagation(); handleDownload(file) }} className="p-1.5 bg-white/20 backdrop-blur text-white rounded hover:bg-white/40 transition-colors"><DownloadIcon className="w-4 h-4" /></button>
                        <button onClick={(e) => { e.stopPropagation(); handleShare(file) }} className="p-1.5 bg-white/20 backdrop-blur text-white rounded hover:bg-white/40 transition-colors"><Share2 className="w-4 h-4" /></button>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          ) : activeTab === 'trash' ? (
             <div className="animate-in fade-in">
              <div className="flex justify-between items-center mb-6">
                <h2 className="text-xl font-bold">Trash</h2>
                {(trashFiles.length > 0 || trashFolders.length > 0) && (
                  <button onClick={handleEmptyTrash} className="px-4 py-2 bg-red-500/10 text-red-400 rounded-xl hover:bg-red-500/20 transition-colors font-medium text-sm">
                    Empty Trash
                  </button>
                )}
              </div>
              {trashFiles.length === 0 && trashFolders.length === 0 ? (
                <div className="flex flex-col items-center justify-center text-neutral-500 py-20">
                  <Trash className="w-16 h-16 opacity-20 mb-4" />
                  <p>Trash is empty</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {[...trashFolders.map(f => ({ ...f, type: 'folder' })), ...trashFiles.map(f => ({ ...f, type: 'file' }))].map(item => (
                    <div key={item.id} className="flex items-center justify-between p-4 bg-[#1A1D27] rounded-xl hover:bg-[#202430] transition-colors">
                      <div className="flex items-center gap-3">
                        {item.type === 'folder' ? <FolderIcon className="w-5 h-5 text-neutral-400" /> : <FileIcon className="w-5 h-5 text-neutral-400" />}
                        <span className="font-medium text-sm text-white/90">{item.name}</span>
                      </div>
                      <button onClick={() => handleRestore(item.id, item.type as any)} className="p-2 text-neutral-400 hover:text-[#5A62FB] transition-colors" title="Restore">
                        <RotateCcw className="w-5 h-5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : activeTab === 'stats' && stats ? (
             <div className="animate-in fade-in space-y-8">
              <h2 className="text-xl font-bold">Storage Stats</h2>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
                <div className="p-6 bg-[#1A1D27] rounded-3xl">
                  <div className="w-10 h-10 rounded-full bg-[#5A62FB]/10 flex items-center justify-center mb-4">
                    <Cloud className="w-5 h-5 text-[#5A62FB]" />
                  </div>
                  <p className="text-sm text-neutral-400">Total Size</p>
                  <p className="text-3xl font-bold mt-1 text-white">{filesize(stats.totalSize)}</p>
                </div>
                <div className="p-6 bg-[#1A1D27] rounded-3xl">
                   <div className="w-10 h-10 rounded-full bg-emerald-500/10 flex items-center justify-center mb-4">
                    <FileIcon className="w-5 h-5 text-emerald-500" />
                  </div>
                  <p className="text-sm text-neutral-400">Total Files</p>
                  <p className="text-3xl font-bold mt-1 text-white">{stats.totalFiles}</p>
                </div>
                <div className="p-6 bg-[#1A1D27] rounded-3xl">
                   <div className="w-10 h-10 rounded-full bg-amber-500/10 flex items-center justify-center mb-4">
                    <FolderIcon className="w-5 h-5 text-amber-500" />
                  </div>
                  <p className="text-sm text-neutral-400">Total Folders</p>
                  <p className="text-3xl font-bold mt-1 text-white">{stats.totalFolders}</p>
                </div>
              </div>
              
              <h3 className="font-semibold text-lg text-white/90">Breakdown by Type</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {stats.byType.map((t: any) => (
                  <div key={t.category} className="p-4 bg-[#1A1D27] rounded-2xl flex justify-between items-center border border-transparent hover:border-white/5 transition-colors">
                    <div>
                      <p className="font-medium text-sm text-white">{t.category}</p>
                      <p className="text-xs text-neutral-500 mt-1">{t.count} files</p>
                    </div>
                    <p className="font-semibold text-sm text-white/80">{filesize(t.size)}</p>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

        </div>
      </main>

      {/* Global Components */}
      <Uploader currentFolderId={currentFolderId} />
      <DownloadBar />

      <FileViewer
        file={viewingFile}
        onClose={() => setViewingFile(null)}
      />

      {/* ── Create Folder Modal ── */}
      <AnimatePresence>
        {isCreatingFolder && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
            <motion.div initial={{ scale: 0.95 }} animate={{ scale: 1 }} exit={{ scale: 0.95 }} className="bg-[#1A1D27] rounded-3xl p-6 w-full max-w-md shadow-2xl border border-white/5">
              <h2 className="text-xl font-bold mb-4 text-white">Create New Folder</h2>
              <form onSubmit={handleCreateFolder}>
                <input type="text" autoFocus value={newFolderName} onChange={(e) => setNewFolderName(e.target.value)} placeholder="Folder name" className="w-full px-4 py-3 border border-white/10 rounded-xl bg-[#0A0D14] text-white focus:ring-2 focus:ring-[#5A62FB] outline-none mb-6 transition-all" />
                <div className="flex justify-end gap-3">
                  <button type="button" onClick={() => setIsCreatingFolder(false)} className="px-5 py-2.5 text-neutral-400 hover:text-white hover:bg-white/5 rounded-xl transition-colors font-medium">Cancel</button>
                  <button type="submit" disabled={!newFolderName.trim()} className="px-5 py-2.5 bg-[#5A62FB] text-white hover:bg-[#4d54d6] disabled:opacity-50 rounded-xl transition-colors font-medium shadow-sm">Create</button>
                </div>
              </form>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Share Modal ── */}
      <AnimatePresence>
        {shareModalFile && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
            <motion.div initial={{ scale: 0.95 }} animate={{ scale: 1 }} exit={{ scale: 0.95 }} className="bg-[#1A1D27] rounded-3xl p-6 w-full max-w-md shadow-2xl border border-white/5">
              <div className="flex justify-between items-center mb-4">
                <h2 className="text-xl font-bold text-white">Share File</h2>
                <button onClick={() => { setShareModalFile(null); setShareLink(null) }} className="p-2 text-neutral-400 hover:text-white hover:bg-white/10 rounded-xl transition-colors"><X className="w-5 h-5" /></button>
              </div>
              <p className="text-sm text-neutral-400 mb-6 leading-relaxed">
                Anyone with this link can preview and download <strong className="text-white">{shareModalFile.name}</strong>. No account required.
              </p>
              {shareLink ? (
                <div className="flex flex-col gap-4">
                  <div className="flex items-center gap-2">
                    <input readOnly value={shareLink} className="flex-1 px-4 py-3 bg-[#0A0D14] border border-white/5 rounded-xl text-sm text-white outline-none" />
                    <button onClick={() => { navigator.clipboard.writeText(shareLink); toast.success('Copied') }} className="p-3 bg-[#5A62FB] text-white rounded-xl hover:bg-[#4d54d6] transition-colors"><Copy className="w-5 h-5" /></button>
                  </div>
                  <button onClick={() => { setShareModalFile(null); setShareLink(null) }} className="w-full py-3 bg-white/5 text-white rounded-xl font-medium hover:bg-white/10 transition-colors">Close</button>
                </div>
              ) : (
                <button onClick={() => handleShare(shareModalFile)} className="w-full py-3 bg-[#5A62FB] text-white rounded-xl font-medium hover:bg-[#4d54d6] transition-colors shadow-lg shadow-[#5A62FB]/20">Generate Link</button>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

    </div>
  )
}
"""

with open('src/pages/Dashboard.tsx', 'w') as f:
    f.write(pre_return + derived_state + new_return + post_dashboard)
