// JREClipper.Core/Services/BasicTranscriptProcessor.cs
using JREClipper.Core.Interfaces;
using JREClipper.Core.Models;
using System.Collections.Generic;
using System.Linq;
using System.Text;

namespace JREClipper.Core.Services
{
    public class BasicTranscriptProcessor : ITranscriptProcessor
    {
        public IEnumerable<string> ChunkTranscript(RawTranscriptData transcriptData, int chunkSize, int overlap)
        {
            if (transcriptData?.Segments == null || !transcriptData.Segments.Any())
            {
                return Enumerable.Empty<string>();
            }

            var fullText = string.Join(" ", transcriptData.Segments.Select(s => s.Text.Trim()));
            var chunks = new List<string>();
            var currentIndex = 0;

            while (currentIndex < fullText.Length)
            {
                var remainingLength = fullText.Length - currentIndex;
                var currentChunkSize = System.Math.Min(chunkSize, remainingLength);
                var chunk = fullText.Substring(currentIndex, currentChunkSize);
                chunks.Add(chunk);

                if (currentIndex + currentChunkSize >= fullText.Length)
                {
                    break; // Reached the end
                }

                currentIndex += (chunkSize - overlap);
                if (currentIndex < 0) // Ensure currentIndex doesn't go negative with large overlap
                {
                    currentIndex = 0;
                }
            }
            return chunks;
        }
    }
}
